/**
 * reachableBase.js — deploy-time facts from GET /api/reachability: Office's
 * EXTERNALLY-REACHABLE base URL, and (new) the configured rendezvous URL for
 * OS-free P2P collaboration.
 *
 * ── Reachable base (NAT-reachability client wiring, two-class app model) ────
 *
 * P2P collab rendezvous is same-origin: a peer joins by opening an invite link
 * that points back at the host box's Office. When the OWNER loaded Office over a
 * LAN-only / private address (e.g. http://192.168.1.20:8080 or a `.local` host)
 * and then invites an EXTERNAL peer, an invite link built from
 * `window.location.origin` would embed that unreachable private address — the
 * external peer can never connect.
 *
 * The box's operator surfaces the real public origin (a public domain, or an
 * Ephor tunnel URL when the box is behind NAT/CGNAT) via the backend env
 * VULOS_OFFICE_PUBLIC_URL, exposed at the unauthenticated `GET /api/reachability`
 * endpoint (see backend/handlers/system.go).
 *
 * When VULOS_OFFICE_PUBLIC_URL is unset (a directly-reachable standalone box, or
 * the cloud deployment where the origin IS public) the resolved base is empty
 * and callers fall back to `window.location.origin` — byte-identical to today.
 *
 * ── Rendezvous URL (standalone P2P with no Vulos OS / host box) ─────────────
 *
 * The SAME endpoint also surfaces `rendezvous_url` (config.yaml
 * `collab.rendezvous_url` / VULOS_RENDEZVOUS_URL — see backend/config/config.go):
 * the base URL of any vulos-relayd's OPEN rendezvous surface (announce/resolve/
 * signal/mailbox + ICE) that the BROWSER talks to DIRECTLY — cross-origin, with
 * no host-box `/api/peering/*` and no Ofisi server in the loop at all (relayd's
 * rendezvous role serves CORS, so our origin never sees the discovery
 * envelopes). When set, a standalone Ofisi binary
 * (which mounts no `/api/peering/*`, see main.go) can still get real
 * peer-to-peer collaboration — see transportSelection.js for how this and
 * host-box peering combine, and docs/COLLABORATION.md §3 for the full picture.
 * Empty when unset, same honesty contract as public_base_url: callers must
 * treat "" as "not configured", never guess a default.
 *
 * Both facts come from ONE fetch (single-flight, cached for the page lifetime —
 * these are deploy-time facts, not per-session ones).
 */

const REACHABILITY_URL = '/api/reachability'
const PROBE_TIMEOUT_MS = 2500

/** @type {Promise<{ base: string, rendezvousUrl: string }> | null} */
let cached = null
/** @type {string} last synchronously-available resolved base ('' until first resolve) */
let resolvedSync = ''
/** @type {string} last synchronously-available resolved rendezvous URL */
let resolvedRendezvousSync = ''

function windowOrigin() {
  return typeof window !== 'undefined' && window.location ? window.location.origin : ''
}

/**
 * Synchronous best-effort reachable base for render paths that cannot await:
 * returns the last resolved public base if `resolveReachableBase()` has already
 * completed, otherwise `window.location.origin`. Warm it by calling
 * `resolveReachableBase()` (e.g. in an effect) before relying on this.
 * @returns {string}
 */
export function reachableBaseSync() {
  return resolvedSync || windowOrigin()
}

/**
 * Synchronous best-effort rendezvous URL for render paths that cannot await:
 * returns the last resolved value if `resolveRendezvousUrl()` (or
 * `resolveReachableBase()`) has already completed, otherwise `''` (not yet
 * known / not configured). Warm it the same way as `reachableBaseSync()`.
 * @returns {string}
 */
export function rendezvousUrlSync() {
  return resolvedRendezvousSync
}

/**
 * Resolve both deploy-time facts from GET /api/reachability in a single
 * request. Never throws: on any network error, non-2xx, or timeout both
 * resolve to their safe defaults (base falls back to `window.location.origin`,
 * rendezvousUrl falls back to `''`). Cached for the page lifetime.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force=false] bypass the cache and re-resolve
 * @returns {Promise<{ base: string, rendezvousUrl: string }>}
 */
function resolveReachability({ force = false } = {}) {
  if (!force && cached) return cached
  const fallback = { base: windowOrigin(), rendezvousUrl: '' }
  if (typeof fetch !== 'function') {
    resolvedSync = fallback.base
    resolvedRendezvousSync = fallback.rendezvousUrl
    return Promise.resolve(fallback)
  }

  cached = (async () => {
    try {
      const hasAbort = typeof AbortController !== 'undefined'
      const ctrl = hasAbort ? new AbortController() : null
      const timer = ctrl ? setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS) : null
      try {
        const res = await fetch(REACHABILITY_URL, { method: 'GET', signal: ctrl?.signal })
        if (!res?.ok) {
          resolvedSync = fallback.base
          resolvedRendezvousSync = fallback.rendezvousUrl
          return fallback
        }
        const body = await res.json()
        const pub = body && typeof body.public_base_url === 'string' ? body.public_base_url.trim() : ''
        const base = pub ? pub.replace(/\/+$/, '') : fallback.base
        const rv = body && typeof body.rendezvous_url === 'string' ? body.rendezvous_url.trim() : ''
        const rendezvousUrl = rv ? rv.replace(/\/+$/, '') : ''
        resolvedSync = base
        resolvedRendezvousSync = rendezvousUrl
        return { base, rendezvousUrl }
      } finally {
        if (timer) clearTimeout(timer)
      }
    } catch {
      resolvedSync = fallback.base
      resolvedRendezvousSync = fallback.rendezvousUrl
      return fallback
    }
  })()
  return cached
}

/**
 * Resolve Office's externally-reachable base origin (no trailing slash).
 * See the module doc for the fallback contract. Cached for the page lifetime
 * (shared with resolveRendezvousUrl() — one fetch serves both).
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force=false] bypass the cache and re-resolve
 * @returns {Promise<string>}
 */
export async function resolveReachableBase(opts) {
  const { base } = await resolveReachability(opts)
  return base
}

/**
 * Resolve the configured rendezvous URL (config.yaml `collab.rendezvous_url` /
 * VULOS_RENDEZVOUS_URL), or `''` when unset / unreachable. See the module doc
 * for the fallback contract. Cached for the page lifetime (shared with
 * resolveReachableBase() — one fetch serves both).
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force=false] bypass the cache and re-resolve
 * @returns {Promise<string>}
 */
export async function resolveRendezvousUrl(opts) {
  const { rendezvousUrl } = await resolveReachability(opts)
  return rendezvousUrl
}

/**
 * Test-only: clear the cached resolution so a fresh fetch runs.
 */
export function _resetReachableBaseCache() {
  cached = null
  resolvedSync = ''
  resolvedRendezvousSync = ''
}
