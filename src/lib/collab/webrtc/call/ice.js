// no-broker-dep:allow-file: names Ephor once, as an example of what a host box MIGHT be, in a
// comment about STUN/TURN config — this file only calls same-origin/relative paths
// (/api/peering/ice, /api/turn/credentials), never a broker-specific endpoint.
//
// ice.js — shared ICE-server fetch helper.
//
// Both the OS fabric path (/api/peering/ice → body.ice_servers) and
// the call/TURN path (/api/turn/credentials → body.iceServers) implement
// the same fetch-with-fallback pattern. This helper centralises it so the
// fallback behaviour is defined once.
//
// STUN/TURN configuration (no other Vulos product required):
//   Diwan's default collaboration transport is direct WebRTC (see
//   docs/COLLABORATION.md). A host box (Vulos OS / Ephor) can supply its
//   own ICE servers via /api/peering/ice, but a standalone/self-hosted Diwan
//   with no host box in front of it needs somewhere else to get STUN (NAT
//   discovery) and, for the ~10-20% of peer pairs behind a symmetric NAT that
//   can't hole-punch at all, TURN (a relay of last resort). resolveIceServers()
//   below is that "somewhere else" — configure it via env/host-injection to
//   point at a self-hosted coturn instance. See docs/COTURN.md for a full
//   coturn setup (apt + docker) and exactly which env vars to set.
//
//   Priority (highest first):
//     1. window.__VULOS_ENDPOINTS__.iceServersFallback — explicit full
//        override (array of RTCIceServer), used verbatim. Escape hatch for
//        hosts that want to inject something ice.js doesn't model.
//     2. window.__VULOS_ENDPOINTS__.stunUrls / .turn (runtime host injection),
//        or the build-time env vars below — merged into one ICE server list:
//          VITE_STUN_URLS         comma-separated stun: URLs
//          VITE_TURN_URL          comma-separated turn:/turns: URLs (your coturn)
//          VITE_TURN_USERNAME     coturn short-term or static username
//          VITE_TURN_CREDENTIAL   coturn short-term or static credential
//     3. Default: the public Google STUN server, STUN only. TURN is NEVER
//        defaulted — a TURN server relays your traffic (unlike STUN, which
//        only helps you discover your own reachable address), so it is
//        opt-in only, via #2 above. Set VITE_STUN_URLS='' explicitly (an
//        empty string, not unset) to disable even the STUN default.
//
// Usage:
//   const servers = await fetchIce('/api/turn/credentials', {
//     responseKey: 'iceServers',        // key inside the JSON response body
//     fetchOptions: { credentials: 'include' },
//     fallbackIceServers: resolveStunFallback(),
//   })

/**
 * The classic Google public STUN server. Exported so callers can opt into it
 * explicitly, or compare against it.
 */
export const GOOGLE_STUN_FALLBACK = [{ urls: ['stun:stun.l.google.com:19302'] }]

function _readEnv(name) {
  try {
    return (import.meta && import.meta.env && import.meta.env[name]) || ''
  } catch {
    return ''
  }
}

function _csv(s) {
  return String(s || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

/**
 * Resolve the STUN/TURN ICE servers to use when the host endpoint (host box's
 * /api/peering/ice, or a configured rendezvous relayd's ICE surface) is
 * unreachable or yields nothing — most notably a standalone Diwan with
 * neither. See the module doc above and docs/COTURN.md.
 *
 * @returns {Array<RTCIceServer>} ICE server objects to fall back to (may be
 *   just STUN, STUN+TURN, or — only if explicitly disabled — empty)
 */
export function resolveStunFallback() {
  try {
    const inj = typeof window !== 'undefined' ? window.__VULOS_ENDPOINTS__ : null

    // #1 — explicit full override, used verbatim.
    if (inj && Array.isArray(inj.iceServersFallback)) return inj.iceServersFallback

    // #2 — STUN + TURN, from host injection or build-time env.
    const stunUrls = (inj && Array.isArray(inj.stunUrls))
      ? inj.stunUrls
      : _csv(_readEnv('VITE_STUN_URLS'))
    const turnCfg = (inj && inj.turn) ? inj.turn : {
      urls: _csv(_readEnv('VITE_TURN_URL')),
      username: _readEnv('VITE_TURN_USERNAME'),
      credential: _readEnv('VITE_TURN_CREDENTIAL'),
    }
    const turnUrls = Array.isArray(turnCfg.urls) ? turnCfg.urls : _csv(turnCfg.urls)

    // An explicit-but-empty VITE_STUN_URLS='' means "no STUN, not even the
    // default" — distinguish "configured empty" from "unconfigured" by
    // checking whether the raw env/injection was present at all.
    const stunExplicitlyConfigured =
      (inj && Array.isArray(inj.stunUrls)) || _readEnv('VITE_STUN_URLS') !== ''
        ? true
        : false

    const servers = []
    if (stunUrls.length) servers.push({ urls: stunUrls })
    if (turnUrls.length) {
      servers.push({
        urls: turnUrls,
        ...(turnCfg.username ? { username: turnCfg.username } : {}),
        ...(turnCfg.credential ? { credential: turnCfg.credential } : {}),
      })
    }
    if (servers.length) return servers
    if (stunExplicitlyConfigured) return [] // explicit opt-out (VITE_STUN_URLS='')

    // Legacy opt-in flag, kept for back-compat.
    if (inj && inj.googleStunFallback === true) return GOOGLE_STUN_FALLBACK
    const legacyEnv = _readEnv('VITE_ICE_GOOGLE_STUN_FALLBACK')
    if (legacyEnv === 'true' || legacyEnv === '1') return GOOGLE_STUN_FALLBACK
  } catch { /* non-browser / no injection — fall through to the default below */ }

  // #3 — default: public STUN only, never TURN.
  return GOOGLE_STUN_FALLBACK
}

/**
 * Fetch ICE servers from a relay/TURN endpoint.
 *
 * @param {string} endpoint      - URL path to GET (e.g. '/api/turn/credentials')
 * @param {object} [opts]
 * @param {string} [opts.responseKey='iceServers']  - key in the JSON body that holds the array
 * @param {object} [opts.fetchOptions={}]           - extra options forwarded to fetch()
 * @param {Array}  [opts.fallbackIceServers=[]]     - servers to return on any
 *        fetch error, non-ok response, or empty array.
 * @returns {Promise<Array>}     - ICE server objects (may be empty)
 */
export async function fetchIce(
  endpoint,
  { responseKey = 'iceServers', fetchOptions = {}, fallbackIceServers = [] } = {},
) {
  try {
    const r = await fetch(endpoint, fetchOptions)
    if (r.ok) {
      const body = await r.json()
      const servers = body[responseKey]
      if (Array.isArray(servers) && servers.length) return servers
    }
  } catch { /* ignore — fall through to the configured fallback */ }
  return Array.isArray(fallbackIceServers) ? fallbackIceServers : []
}
