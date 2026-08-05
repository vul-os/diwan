// no-broker-dep:allow-file: names Pier/vulos-relayd three times below describing the
// OPTIONAL, explicitly-configured rendezvous_url and DIWAN_PUBLIC_URL — this file's own text
// states "Empty when unset... callers must treat '' as 'not configured', never guess a
// default" and documents the built-in surface as "the DEFAULT path — no other product at
// all". Verified: backend/config/config_test.go's TestDefault_RendezvousURLEmpty.
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
 * Pier tunnel URL when the box is behind NAT/CGNAT) via the backend env
 * DIWAN_PUBLIC_URL, exposed at the unauthenticated `GET /api/reachability`
 * endpoint (see backend/handlers/system.go).
 *
 * When DIWAN_PUBLIC_URL is unset (a directly-reachable standalone box, or
 * the cloud deployment where the origin IS public) the resolved base is empty
 * and callers fall back to `window.location.origin` — byte-identical to today.
 *
 * ── Rendezvous URL (standalone P2P with no Vulos OS / host box) ─────────────
 *
 * The SAME endpoint also surfaces `rendezvous_url` (config.yaml
 * `collab.rendezvous_url` / VULOS_RENDEZVOUS_URL — see backend/config/config.go):
 * the base URL of any vulos-relayd's OPEN rendezvous surface (announce/resolve/
 * signal/mailbox + ICE) that the BROWSER talks to DIRECTLY — cross-origin, with
 * no host-box `/api/peering/*` and no Diwan server in the loop at all (relayd's
 * rendezvous role serves CORS, so our origin never sees the discovery
 * envelopes). When set, a standalone Diwan binary
 * (which mounts no `/api/peering/*`, see main.go) can still get real
 * peer-to-peer collaboration — see transportSelection.js for how this and
 * host-box peering combine, and docs/COLLABORATION.md §3 for the full picture.
 * Empty when unset, same honesty contract as public_base_url: callers must
 * treat "" as "not configured", never guess a default.
 *
 * ── Built-in rendezvous prefix (the DEFAULT path — no other product at all) ──
 *
 * The same endpoint surfaces `builtin_rendezvous_prefix`: the path under THIS
 * origin at which the Diwan binary serves its OWN signed, content-blind
 * peer-discovery protocol (backend/rendezvous, `/api/rendezvous/*`). It is on by
 * default, so a bare `diwan` on a VPS can introduce two browsers to each other
 * with no Vulos OS, no Pier, and no external relay — which is the whole reason
 * it exists. `''` when the operator turned it off (`collab.builtin_rendezvous:
 * false`) or the server predates it, and `''` must mean local-only rather than a
 * guessed path.
 *
 * All three facts come from ONE fetch (single-flight, cached for the page
 * lifetime — these are deploy-time facts, not per-session ones).
 */

const REACHABILITY_URL = '/api/reachability'
const PROBE_TIMEOUT_MS = 2500

type ReachabilityFacts = { base: string; rendezvousUrl: string; builtinPrefix: string }

let cached: Promise<ReachabilityFacts> | null = null
/** last synchronously-available resolved base ('' until first resolve) */
let resolvedSync = ''
/** last synchronously-available resolved rendezvous URL */
let resolvedRendezvousSync = ''
/** last synchronously-available built-in rendezvous prefix */
let resolvedBuiltinSync = ''

function windowOrigin(): string {
  return typeof window !== 'undefined' && window.location ? window.location.origin : ''
}

/**
 * Synchronous best-effort reachable base for render paths that cannot await:
 * returns the last resolved public base if `resolveReachableBase()` has already
 * completed, otherwise `window.location.origin`. Warm it by calling
 * `resolveReachableBase()` (e.g. in an effect) before relying on this.
 */
export function reachableBaseSync(): string {
  return resolvedSync || windowOrigin()
}

/**
 * Synchronous best-effort rendezvous URL for render paths that cannot await:
 * returns the last resolved value if `resolveRendezvousUrl()` (or
 * `resolveReachableBase()`) has already completed, otherwise `''` (not yet
 * known / not configured). Warm it the same way as `reachableBaseSync()`.
 */
export function rendezvousUrlSync(): string {
  return resolvedRendezvousSync
}

/**
 * Resolve both deploy-time facts from GET /api/reachability in a single
 * request. Never throws: on any network error, non-2xx, or timeout both
 * resolve to their safe defaults (base falls back to `window.location.origin`,
 * rendezvousUrl falls back to `''`). Cached for the page lifetime.
 *
 * @param opts.force  bypass the cache and re-resolve
 */
function resolveReachability({ force = false }: { force?: boolean } = {}): Promise<ReachabilityFacts> {
  if (!force && cached) return cached
  const fallback = { base: windowOrigin(), rendezvousUrl: '', builtinPrefix: '' }
  const applyFallback = () => {
    resolvedSync = fallback.base
    resolvedRendezvousSync = fallback.rendezvousUrl
    resolvedBuiltinSync = fallback.builtinPrefix
    return fallback
  }
  if (typeof fetch !== 'function') {
    return Promise.resolve(applyFallback())
  }

  cached = (async () => {
    try {
      const hasAbort = typeof AbortController !== 'undefined'
      const ctrl = hasAbort ? new AbortController() : null
      const timer = ctrl ? setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS) : null
      try {
        const res = await fetch(REACHABILITY_URL, { method: 'GET', signal: ctrl?.signal ?? null })
        if (!res?.ok) return applyFallback()
        const body: { public_base_url?: unknown; rendezvous_url?: unknown; builtin_rendezvous_prefix?: unknown } = await res.json()
        const pub = body && typeof body.public_base_url === 'string' ? body.public_base_url.trim() : ''
        const base = pub ? pub.replace(/\/+$/, '') : fallback.base
        const rv = body && typeof body.rendezvous_url === 'string' ? body.rendezvous_url.trim() : ''
        const rendezvousUrl = rv ? rv.replace(/\/+$/, '') : ''
        // A server that predates the built-in surface, or one that turned it off,
        // sends no prefix / an empty one. Absent MUST mean "no built-in
        // discovery" and never a guessed path, or a deployment that deliberately
        // disabled it would find the browser calling it anyway.
        const bp = body && typeof body.builtin_rendezvous_prefix === 'string'
          ? body.builtin_rendezvous_prefix.trim()
          : ''
        const builtinPrefix = bp ? bp.replace(/\/+$/, '') : ''
        resolvedSync = base
        resolvedRendezvousSync = rendezvousUrl
        resolvedBuiltinSync = builtinPrefix
        return { base, rendezvousUrl, builtinPrefix }
      } finally {
        if (timer) clearTimeout(timer)
      }
    } catch {
      return applyFallback()
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
export async function resolveReachableBase(opts?: { force?: boolean }): Promise<string> {
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
export async function resolveRendezvousUrl(opts?: { force?: boolean }): Promise<string> {
  const { rendezvousUrl } = await resolveReachability(opts)
  return rendezvousUrl
}

/**
 * Resolve the path prefix at which THIS Diwan server serves its own built-in
 * peer-discovery surface (`/api/rendezvous` — see backend/rendezvous), or `''`
 * when the operator disabled it (`collab.builtin_rendezvous: false`) or the
 * server is too old to report it.
 *
 * A PATH, not a URL: the surface is same-origin by construction, and the browser
 * is the only party that reliably knows which origin it loaded Diwan from (the
 * server sits behind whatever reverse proxy the operator chose). Callers join it
 * to their own origin — see selectCollabTransport, which also refuses anything
 * that is not an absolute same-origin path.
 *
 * Same honesty contract as the two above: `''` means "not available", never
 * "guess". Cached for the page lifetime (one fetch serves all three).
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force=false] bypass the cache and re-resolve
 * @returns {Promise<string>}
 */
export async function resolveBuiltinRendezvousPrefix(opts?: { force?: boolean }): Promise<string> {
  const { builtinPrefix } = await resolveReachability(opts)
  return builtinPrefix
}

/**
 * Synchronous best-effort built-in-rendezvous prefix, for render paths that
 * cannot await. `''` until a resolve has completed. Warm it the same way as
 * `reachableBaseSync()`.
 * @returns {string}
 */
export function builtinRendezvousPrefixSync(): string {
  return resolvedBuiltinSync
}

/**
 * Test-only: clear the cached resolution so a fresh fetch runs.
 */
export function _resetReachableBaseCache(): void {
  cached = null
  resolvedSync = ''
  resolvedRendezvousSync = ''
  resolvedBuiltinSync = ''
}
