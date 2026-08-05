/**
 * peeringAvailability.js — capability probe for the Vulos peering fabric
 * (`/api/peering/*`).
 *
 * The STANDALONE Office binary (see main.go) never mounts `/api/peering/ice`
 * or `/api/peering/stream` — that fabric is provided by a Vulos OS / Vulos
 * Relay host in front of Office (see docs/COLLABORATION.md §4, docs/
 * ADMIN-GUIDE.md "Peering fabric"). Unfortunately FabricClient's (src/lib/
 * collab/webrtc/fabric.js) join() resolves successfully even when the signaling
 * WebSocket never connects: it fire-and-forgets the WS connect (retrying with
 * backoff in the background) and its ICE fetch silently falls back to an
 * empty server list on a 404. Left unchecked, that means `configured`/
 * `joined` flip true and status pills like Sheets/Slides' ConnectionPill
 * settle on a calm "Live" — a false positive — even though no peer can ever
 * actually reach this session, and "Collaborate via link" invites mint links
 * that will never connect anyone.
 *
 * This module gives callers an honest, fast, non-throwing answer BEFORE they
 * commit to a fabric session, so the UI can say "unavailable" instead of
 * silently pretending to be live. See useCollabFabric.js and useP2PCollab.js.
 *
 * The result is cached per iceUrl for the lifetime of the page: whether this
 * origin serves the peering fabric is a deploy-time fact that cannot change
 * mid-session, so there is no reason to re-probe on every editor mount.
 */

const PROBE_TIMEOUT_MS = 2500

const cache = new Map<string, Promise<boolean>>()

/**
 * Resolve whether the peering fabric is reachable on this origin by probing
 * its ICE-credentials endpoint. Never throws; resolves `false` on any
 * network error, non-2xx response, or timeout — exactly the standalone-Office
 * case (no `/api/peering/*` routes mounted at all → 404).
 *
 * @param opts.iceUrl default '/api/peering/ice'
 * @param opts.force  bypass the cache and re-probe
 */
export function probePeeringAvailable(
  { iceUrl = '/api/peering/ice', force = false }: { iceUrl?: string; force?: boolean } = {}
): Promise<boolean> {
  if (typeof fetch !== 'function') return Promise.resolve(false)
  if (!force && cache.has(iceUrl)) return cache.get(iceUrl) as Promise<boolean>

  const probe = (async () => {
    try {
      const hasAbort = typeof AbortController !== 'undefined'
      const ctrl = hasAbort ? new AbortController() : null
      const timer = ctrl ? setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS) : null
      try {
        const res = await fetch(iceUrl, { method: 'GET', signal: ctrl?.signal ?? null })
        return !!res?.ok
      } finally {
        if (timer) clearTimeout(timer)
      }
    } catch {
      // Network error, abort/timeout, or CORS failure — treat as unavailable.
      // This is the expected path on a standalone server (no route → the
      // fetch either 404s, which we handle via res.ok above, or in rarer
      // sandboxed environments throws outright).
      return false
    }
  })()

  cache.set(iceUrl, probe)
  return probe
}

/**
 * Test-only: clear the cached probe result(s) so a fresh probe runs. Not used
 * in production code — each real session lives for the whole page lifetime.
 * @param iceUrl clear only this key; omit to clear everything.
 */
export function _resetPeeringProbeCache(iceUrl?: string): void {
  if (iceUrl) cache.delete(iceUrl)
  else cache.clear()
}
