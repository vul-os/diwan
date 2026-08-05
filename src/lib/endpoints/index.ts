/**
 * src/lib/endpoints/index.js — Diwan's cloud↔LAN endpoint failover.
 *
 * First-party (re-homed from the vendored relay-client package —
 * endpoint selection is not P2P/relay functionality, just failover between a
 * cloud route and a directly-reachable LAN box, so it lives in Diwan's own
 * tree rather than depending on another product's package).
 *
 * Shared cloud↔LAN endpoint failover, historically duplicated across every
 * Vulos web surface (the OS shell, diwan). Promoted from the vulos OS
 * copy (the richest — it owned `seedFromResolveBackend`) with two opt-in
 * config seams so each surface can migrate without disturbing existing user
 * state:
 *
 *   • `lsKeyPrefix`  — localStorage namespace (default
 *                      'vulos.relay-client.endpoints.v1'). Consumers that
 *                      already have a populated cache pass their old key
 *                      ('vulos.os.endpoints.v1', 'vulos.office.endpoints.v1')
 *                      via `configure()` so the first post-migration load sees
 *                      the same cached pair and no failover re-probe is forced.
 *   • `healthPath`   — relative URL appended to a base for the reachability
 *                      probe. Defaults to /api/auth/status. Surfaces that use
 *                      a different auth endpoint can override this value.
 *
 * Behaviour (frozen contract — identical across all three surfaces):
 *
 *   • Cache BOTH a cloud endpoint and a LAN endpoint.
 *   • Health-check each candidate.
 *   • Prefer the reachable one — LAN-direct is preferred for latency
 *     (it works with the internet down and avoids a round-trip through
 *     the cloud control plane).
 *   • Cloud-routing failure → transparently fall back to the cached LAN
 *     endpoint (and vice-versa). No user action required.
 *
 * The selected endpoint is a *base URL* (origin + optional path prefix) that
 * API clients prepend to `/api/...` paths. When the web client is served from
 * the OS box itself the default same-origin endpoint is used and this layer is
 * a transparent no-op — meaningful failover only kicks in when the shell is
 * loaded from the cloud (cloud-routed install) and the box also has a
 * reachable LAN endpoint.
 *
 * Endpoint discovery (in priority order):
 *   1. window.__VULOS_ENDPOINTS__ injected by the OS shell at serve time:
 *        { cloud: "https://<box>.vulos.org",
 *          lan:   "https://box.<id>.lan.vulos.org" }
 *      (these are exactly the cloud + LAN endpoints returned by the cloud
 *      control plane's ResolveBackend — Endpoint + LANCandidate.Endpoint).
 *   2. Vite env: VITE_CLOUD_ENDPOINT / VITE_LAN_ENDPOINT (build-time).
 *   3. localStorage cache (last known-good endpoints), persisted across loads
 *      so failover keeps working with the internet — and the discovery cloud —
 *      down.
 *   4. Same-origin fallback ('') so a standalone OSS/self-host build still
 *      works without any of the above being configured.
 *
 * Also exposes seedFromResolveBackend(target) for callers that have just
 * received a fresh BackendTarget from the cloud's /api/resolve/backend
 * endpoint — the response is fed through the same persistence path so the
 * next page load already has both endpoints cached.
 *
 * Pure JS — no framework, no native deps.
 */

// Default config — overridable via configure() so the three consumers can
// migrate without losing their existing localStorage cache.
const DEFAULT_LS_KEY = 'vulos.relay-client.endpoints.v1'
const DEFAULT_HEALTH_PATH = '/api/auth/status'

let _lsKey = DEFAULT_LS_KEY
let _healthPath = DEFAULT_HEALTH_PATH

// Extra hosts the consumer trusts for *credentialed* health probes, on top of
// same-origin and the configured (injected/env) cloud+LAN endpoints. Entries
// may be an exact host[:port] ('box.vulos.org'), a leading-dot suffix
// ('.vulos.org' → any subdomain of vulos.org), or a '*.suffix' wildcard.
// See configure({ allowedProbeHosts }).
let _allowedProbeHosts: string[] = []

// Hosts learned from a trusted BackendTarget via seedFromResolveBackend() (the
// cloud control plane's /api/resolve/backend response). These are as trusted as
// injected/env endpoints for the purpose of the credentialed-probe allowlist.
const _seededHosts: string[] = []

// How long a health-probe may take before the endpoint is considered down.
const HEALTH_TIMEOUT_MS = 2_500

// Re-validate the selected endpoint at most this often (ms). A failed request
// always forces an immediate re-selection regardless of this interval.
const REVALIDATE_AFTER_MS = 30_000

export type EndpointPair = { cloud: string; lan: string }

type State = {
  pair: EndpointPair
  /** Currently selected base URL ('' = same-origin). */
  selected: string
  /** Timestamp (ms) of the last successful selection. */
  selectedAt: number
  /** In-flight selection promise (deduped). */
  selecting: Promise<string> | null
}

const _state: State = {
  pair: { cloud: '', lan: '' },
  selected: '',
  selectedAt: 0,
  selecting: null,
}

type EndpointListener = (selected: string) => void
const listeners = new Set<EndpointListener>()

function emit() {
  for (const fn of listeners) {
    try { fn(_state.selected) } catch { /* listener errors are non-fatal */ }
  }
}

/** Subscribe to selected-endpoint changes. Returns an unsubscribe fn. */
export function onEndpointChange(fn: EndpointListener) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Override the localStorage key prefix and/or health probe path. Intended to
 * be called once at app entry, before bootstrap, by consumers that need to
 * preserve their pre-migration cache or that use a different health endpoint.
 *
 *   configure({ lsKeyPrefix: 'vulos.os.endpoints.v1' })       // OS surface
 *   configure({ lsKeyPrefix: 'vulos.office.endpoints.v1' })   // office suite
 *   configure({ lsKeyPrefix: 'my.app.endpoints.v1',
 *               healthPath:  '/api/health' })                  // custom surface
 *
 *   configure({ allowedProbeHosts: ['.vulos.org'] })           // lock probes
 *                                                               // to a domain
 *
 */
export function configure(opts: { lsKeyPrefix?: string; healthPath?: string; allowedProbeHosts?: string[] } = {}) {
  if (opts && typeof opts === 'object') {
    if (typeof opts.lsKeyPrefix === 'string' && opts.lsKeyPrefix) {
      _lsKey = opts.lsKeyPrefix
    }
    if (typeof opts.healthPath === 'string' && opts.healthPath) {
      _healthPath = opts.healthPath
    }
    if (Array.isArray(opts.allowedProbeHosts)) {
      _allowedProbeHosts = opts.allowedProbeHosts.filter(
        (h) => typeof h === 'string' && h,
      )
    }
  }
  return {
    lsKeyPrefix: _lsKey,
    healthPath: _healthPath,
    allowedProbeHosts: _allowedProbeHosts.slice(),
  }
}

// ─── Endpoint URL validation (audit MED — cookie exfil via unvalidated probe
//     targets) ──────────────────────────────────────────────────────────────
//
// Endpoint base URLs come from three sources, two of which an attacker could
// influence: window.__VULOS_ENDPOINTS__ / VITE_* (set by the trusted host) and
// the localStorage cache (poisonable via XSS or a shared origin). Because the
// reachability probe sends `credentials: 'include'`, an unvalidated base URL
// would let a poisoned cache exfiltrate the session cookie to an arbitrary
// host. We therefore:
//   1. Sanitise cached endpoints on read — drop anything that isn't '' or a
//      well-formed https:// (or same-origin) URL.
//   2. Gate the credentialed probe — only fetch with credentials against
//      same-origin OR an https host on the allowlist (same-origin host + the
//      configured injected/env endpoint hosts + configure({ allowedProbeHosts })).

/** Parse a base URL (origin or origin+path prefix) into a URL, or null. */
function parseBase(base: unknown): URL | null {
  if (typeof base !== 'string' || base === '') return null
  try {
    const ref =
      typeof location !== 'undefined' && location.href ? location.href : undefined
    return new URL(base, ref)
  } catch {
    return null
  }
}

/** This document's host ('' when not in a browser). */
function sameOriginHost(): string {
  try {
    if (typeof location !== 'undefined' && location.host) return location.host
  } catch { /* ignore */ }
  return ''
}

/** True when `base` is '' (same-origin) or a well-formed https/same-origin URL. */
function isSafeEndpointScheme(base: string): boolean {
  if (base === '') return true
  const u = parseBase(base)
  if (!u) return false
  if (u.protocol === 'https:') return true
  // Allow a same-origin absolute URL even over http (dev / localhost).
  try {
    if (typeof location !== 'undefined' && location.origin && u.origin === location.origin) {
      return true
    }
  } catch { /* ignore */ }
  return false
}

/** Keep a cached endpoint only if it passes scheme validation; else ''. */
function sanitizeEndpoint(base: string): string {
  return isSafeEndpointScheme(base) ? base : ''
}

/** Hosts of the configured (injected/env) cloud+LAN endpoints — trusted config. */
function configuredHosts(): string[] {
  const out: string[] = []
  const inj = readInjected()
  const candidates = [
    inj && inj.cloud,
    inj && inj.lan,
    readEnv('VITE_CLOUD_ENDPOINT'),
    readEnv('VITE_LAN_ENDPOINT'),
  ]
  for (const c of candidates) {
    const u = c && parseBase(c)
    if (u && u.host) out.push(u.host)
  }
  for (const h of _seededHosts) out.push(h)
  return out
}

/** Match a host against one allowlist entry (exact, '.suffix', or '*.suffix'). */
function hostMatches(host: string, entry: string): boolean {
  if (host === entry) return true
  if (entry.startsWith('.')) return host.endsWith(entry) || host === entry.slice(1)
  if (entry.startsWith('*.')) {
    const suffix = entry.slice(1) // '.suffix'
    return host.endsWith(suffix) || host === entry.slice(2)
  }
  return false
}

/**
 * May we send a *credentialed* probe to this base URL? Same-origin is always
 * allowed; cross-origin requires https AND a host on the allowlist (configured
 * endpoint hosts + explicit allowedProbeHosts). Empty base = same-origin.
 */
function isCredentialedProbeAllowed(base: string): boolean {
  if (base === '') return true
  const u = parseBase(base)
  if (!u) return false
  try {
    if (typeof location !== 'undefined' && location.origin && u.origin === location.origin) {
      return true
    }
  } catch { /* ignore */ }
  if (u.protocol !== 'https:') return false
  const host = u.host
  if (host && host === sameOriginHost()) return true
  for (const h of configuredHosts()) {
    if (host === h) return true
  }
  for (const entry of _allowedProbeHosts) {
    if (hostMatches(host, entry)) return true
  }
  return false
}

function readEnv(name: string): string {
  try {
    return (import.meta && import.meta.env && import.meta.env[name]) || ''
  } catch {
    return ''
  }
}

function readInjected(): EndpointPair | null {
  try {
    const g = typeof window !== 'undefined' ? window.__VULOS_ENDPOINTS__ : null
    if (g && typeof g === 'object') return { cloud: g.cloud || '', lan: g.lan || '' }
  } catch { /* ignore */ }
  return null
}

function readCache(): EndpointPair | null {
  try {
    const raw = typeof localStorage !== 'undefined' && localStorage.getItem(_lsKey)
    if (!raw) return null
    const v = JSON.parse(raw)
    if (v && typeof v === 'object') {
      // Validate on read: a poisoned cache must not feed an unsafe base URL into
      // the credentialed probe. Anything that isn't '' or a well-formed
      // https/same-origin URL is dropped.
      return {
        cloud: sanitizeEndpoint(v.cloud || ''),
        lan: sanitizeEndpoint(v.lan || ''),
      }
    }
  } catch { /* ignore */ }
  return null
}

function writeCache(pair: EndpointPair) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(_lsKey, JSON.stringify({ cloud: pair.cloud, lan: pair.lan }))
    }
  } catch { /* storage may be unavailable (private mode) */ }
}

/**
 * Resolve the cloud + LAN endpoint pair from all sources, caching the result.
 * Injected/env values take priority; otherwise the last cached pair is reused
 * so failover survives a cloud-discovery outage.
 */
export function resolveEndpoints(): EndpointPair {
  const injected = readInjected()
  const cached = readCache()

  const cloud =
    (injected && injected.cloud) ||
    readEnv('VITE_CLOUD_ENDPOINT') ||
    (cached && cached.cloud) ||
    ''
  const lan =
    (injected && injected.lan) ||
    readEnv('VITE_LAN_ENDPOINT') ||
    (cached && cached.lan) ||
    ''

  _state.pair = { cloud, lan }

  // Persist whatever we discovered so a later offline load still has both
  // endpoints to fail over between.
  if (cloud || lan) writeCache(_state.pair)
  return _state.pair
}

/**
 * Seed the endpoint pair from a freshly-fetched BackendTarget returned by the
 * cloud control plane's /api/resolve/backend endpoint.
 *
 *   target = {
 *     Endpoint:     "https://<box>.vulos.org",        // cloud-routed
 *     LANCandidate: { BoxID, Endpoint: "https://box.<id>.lan.vulos.org" } | null,
 *     // …other fields…
 *   }
 *
 * The LANCandidate field is a pointer + omitempty on the wire so legacy
 * clients see byte-identical JSON when no LAN candidate is advertised. Either
 * field may be absent; this function preserves whatever it already had cached
 * for the missing side and triggers an immediate re-selection so the live
 * pair is exercised at once.
 */
type BackendTarget = {
  Endpoint?: string
  endpoint?: string
  LANCandidate?: { Endpoint?: string; endpoint?: string } | null
  lan_candidate?: { Endpoint?: string; endpoint?: string } | null
}

export function seedFromResolveBackend(target: BackendTarget | null | undefined): EndpointPair {
  if (!target || typeof target !== 'object') return _state.pair
  const cached = readCache() || { cloud: '', lan: '' }
  const cloud = target.Endpoint || target.endpoint || cached.cloud || ''
  const lanCand = target.LANCandidate || target.lan_candidate || null
  const lan =
    (lanCand && (lanCand.Endpoint || lanCand.endpoint)) || cached.lan || ''
  _state.pair = { cloud, lan }
  if (cloud || lan) writeCache(_state.pair)
  // Trust the seeded hosts for credentialed probes — this is a control-plane
  // response, as authoritative as an injected/env endpoint.
  for (const b of [cloud, lan]) {
    const u = b && parseBase(b)
    if (u && u.host && !_seededHosts.includes(u.host)) _seededHosts.push(u.host)
  }
  // Force a re-probe — the freshly-seeded pair should be exercised now, not
  // after the cached selection's TTL.
  invalidateEndpoint()
  return _state.pair
}

/**
 * Health-check a single base URL. Resolves to true when the endpoint answers
 * within HEALTH_TIMEOUT_MS (any HTTP status counts as reachable — a 401/403 on
 * the configured health path still proves the box is up). Same-origin ('') is
 * always usable.
 */
export async function probe(base: string): Promise<boolean> {
  // An empty base means same-origin: assume reachable if the document is
  // online, and trivially reachable when offline reads come from the SW cache.
  if (base === '') {
    return typeof navigator === 'undefined' || navigator.onLine !== false
  }
  // Refuse to send a credentialed request to an unvalidated / off-allowlist
  // target — this is the cookie-exfil guard. Such a candidate is treated as
  // unreachable so selection falls through to a safe endpoint.
  if (!isCredentialedProbeAllowed(base)) {
    return false
  }
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = ctrl ? setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS) : null
  try {
    const res = await fetch(base + _healthPath, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      signal: ctrl ? ctrl.signal : null,
    })
    // Any response — including 401/403 — means the endpoint is reachable.
    return !!res
  } catch {
    return false
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Select the best reachable endpoint.
 *
 * Preference order (frozen contract):
 *   1. LAN-direct (lowest latency, works with the internet down).
 *   2. Cloud.
 *   3. Same-origin fallback ('').
 *
 * The first candidate that passes a health-probe wins. Probing the preferred
 * candidates is done concurrently so a dead cloud route doesn't add latency to
 * picking the live LAN one.
 *
 * @returns the selected base URL
 */
export async function selectEndpoint(opts: { force?: boolean } = {}): Promise<string> {
  const { force = false } = opts

  // Reuse a recent successful selection unless forced (e.g. after a failure).
  if (!force && _state.selected !== undefined &&
      _state.selectedAt && Date.now() - _state.selectedAt < REVALIDATE_AFTER_MS) {
    return _state.selected
  }
  // Dedupe concurrent callers.
  if (_state.selecting) return _state.selecting

  _state.selecting = (async () => {
    const { cloud, lan } = resolveEndpoints()

    // Candidate list, LAN preferred for latency, then cloud, then same-origin.
    const candidates = []
    if (lan) candidates.push(lan)
    if (cloud) candidates.push(cloud)
    candidates.push('') // same-origin fallback is always last and always present

    // Probe LAN and cloud concurrently; same-origin is resolved without a
    // network round-trip.
    const probed = await Promise.all(
      candidates.map(async (base) => ({ base, ok: await probe(base) }))
    )

    const winner = probed.find((c) => c.ok)
    const selected = winner ? winner.base : ''

    const changed = selected !== _state.selected
    _state.selected = selected
    _state.selectedAt = Date.now()
    _state.selecting = null
    if (changed) emit()
    return selected
  })()

  return _state.selecting
}

/** The currently selected base URL (synchronous; '' = same-origin). */
export function currentEndpoint(): string {
  return _state.selected
}

/**
 * Invalidate the current selection. Called by the API client when a request to
 * the selected endpoint fails so the next call re-probes and fails over.
 */
export function invalidateEndpoint(): void {
  _state.selectedAt = 0
}

// Re-select on connectivity changes so we fail over the moment the network
// state flips (cloud-down → LAN, LAN-down → cloud, offline → online).
//
// Debounce: Wi-Fi handoffs and some mobile network transitions fire online +
// offline in rapid succession, which without debouncing would trigger a
// parallel storm of health probes — one for every event. A 400 ms quiet
// period coalesces the burst into a single re-probe without meaningfully
// delaying failover detection (which already has a REVALIDATE_AFTER_MS TTL).
if (typeof window !== 'undefined' && window.addEventListener) {
  const RESELECT_DEBOUNCE_MS = 400
  let _reselectTimer: ReturnType<typeof setTimeout> | null = null
  const reselect = () => {
    if (_reselectTimer !== null) clearTimeout(_reselectTimer)
    _reselectTimer = setTimeout(() => {
      _reselectTimer = null
      selectEndpoint({ force: true })
    }, RESELECT_DEBOUNCE_MS)
  }
  window.addEventListener('online', reselect)
  window.addEventListener('offline', reselect)
}
