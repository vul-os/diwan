// no-broker-dep:allow-file: names Pier/vulos-relayd three times below while documenting the
// full priority chain — this file's own text states "NO DEFAULT ENDPOINT, in any branch" and
// names RENDEZVOUS(built-in) as "THE DEFAULT". Verified: backend/config/config_test.go's
// TestDefault_RendezvousURLEmpty.
/**
 * transportSelection.js — the collaboration transport decision.
 *
 * Every FabricClient construction site in Diwan (useCollabFabric.js for
 * presence/Sheets/Slides doc-sync, useP2PCollab.js for Docs/Whiteboard invite
 * links) needs the same answer to "how do we reach a peer?", in the same
 * priority order:
 *
 *   1. HOST_PEERING  — this server itself mounts `/api/peering/*` (a Vulos OS
 *      or Pier host is in front of Diwan). Preferred when present:
 *      unchanged from Diwan's original behaviour, and it is the one transport
 *      that can carry an authToken tied to an account session.
 *   2. RENDEZVOUS (external) — no host-box peering, but this deployment names
 *      somebody else's rendezvous surface: config.yaml `collab.rendezvous_url` /
 *      VULOS_RENDEZVOUS_URL (see backend/config/config.go) — typically a
 *      self-hosted `vulos-relayd`'s open announce/resolve/signal/mailbox + ICE
 *      surface. The browser calls that origin DIRECTLY, cross-origin; Diwan's
 *      server is not in the discovery path at all, so it never sees even the
 *      (already content-blind) rendezvous envelopes. This relies on the relay
 *      serving CORS. Configuring it is an EXPLICIT operator choice, which is why
 *      it outranks the built-in surface below.
 *   3. RENDEZVOUS (built-in) — this Diwan binary's OWN discovery surface,
 *      `/api/rendezvous/*` on this very origin (backend/rendezvous), advertised
 *      by GET /api/reachability as `builtin_rendezvous_prefix`.
 *
 *      THIS IS THE DEFAULT, and it is what makes a bare `diwan` binary capable
 *      of real peer-to-peer collaboration on its own. WebRTC cannot introduce two
 *      browsers unaided — something has to pass the first offer/answer/ICE
 *      frames — and until this existed, Diwan could only get that from ANOTHER
 *      product (a Vulos OS / Pier host, or an operator-run relayd). With
 *      neither, every session fell through to local-only. One Diwan on one VPS is
 *      now sufficient.
 *
 *      It carries no document content: payloads are opaque bytes sealed under a
 *      room key that lives in the invite link's URL fragment and reaches no
 *      server, and edits ride the direct data channel once peers are introduced.
 *      What the operator's own box does see is discovery metadata — which is the
 *      honest cost of hosting your own signalling, and strictly less exposure
 *      than handing that metadata to a third party's relay.
 *   4. LOCAL_ONLY    — none of the above is available (the operator turned the
 *      built-in surface off with `collab.builtin_rendezvous: false` and named no
 *      relay, or the reachability probe found nothing). The editor keeps working;
 *      it just never opens a transport. Honest "Offline" / disabled affordances,
 *      never a false "Live".
 *
 * NO DEFAULT ENDPOINT, in any branch. Every URL here comes from this deployment:
 * either the operator's own config, or this page's own origin. Nothing points at
 * a Vulos-run service, and an unconfigured deployment with the built-in surface
 * disabled stays honestly local-only rather than silently phoning somewhere.
 *
 * Centralising the decision here (rather than duplicating the probe-then-branch
 * logic in every hook) is what keeps the three call sites in agreement and
 * keeps the logic unit-testable without a DOM or a real network.
 *
 * See docs/COLLABORATION.md §3 for the user-facing explanation of all four.
 */

import { probePeeringAvailable } from './peeringAvailability.js'
import { resolveRendezvousUrl, resolveBuiltinRendezvousPrefix } from './reachableBase.js'

export const TRANSPORT_HOST_PEERING = 'host-peering'
export const TRANSPORT_RENDEZVOUS = 'rendezvous'
export const TRANSPORT_LOCAL_ONLY = 'local-only'

/**
 * A relayd's own mount prefix for the rendezvous protocol — its
 * `-rendezvous-prefix` default, and what `collab.rendezvous_url` is expected to
 * front. Only used for the EXTERNAL relay case; the built-in surface reports its
 * own prefix through /api/reachability.
 */
export const RENDEZVOUS_PREFIX = '/rendezvous'

/**
 * @typedef {object} TransportChoice
 * @property {'host-peering'|'rendezvous'|'local-only'} transport
 * @property {string} rendezvousBaseUrl  origin the browser calls — an
 *   operator-configured relay, or this page's own origin for the built-in
 *   surface; '' unless transport is 'rendezvous'
 * @property {string} rendezvousPrefix  path prefix under that origin ('' unless
 *   transport is 'rendezvous')
 * @property {boolean} builtin  true when the chosen rendezvous surface is this
 *   Diwan server's own. Callers use it for honest UI copy ("discovery runs on
 *   this server" vs "on <relay>"); it is never a security decision.
 */

/**
 * Decide which collaboration transport this session should use. Never throws:
 * every probe it depends on already fails safe to "unavailable" and this
 * function itself always resolves to one of the three transports.
 *
 * @param {object} [opts]
 * @param {() => Promise<boolean>} [opts.probeHostPeering] override for tests
 * @param {() => Promise<string>} [opts.resolveRendezvous] override for tests
 * @param {() => Promise<string>} [opts.resolveBuiltinPrefix] override for tests
 * @param {string} [opts.origin] this page's origin (tests inject; defaults to
 *   window.location.origin)
 * @returns {Promise<TransportChoice>}
 */
export async function selectCollabTransport({
  probeHostPeering = probePeeringAvailable,
  resolveRendezvous = resolveRendezvousUrl,
  resolveBuiltinPrefix = resolveBuiltinRendezvousPrefix,
  origin = typeof window !== 'undefined' && window.location ? window.location.origin : '',
} = {}) {
  const none = {
    transport: TRANSPORT_LOCAL_ONLY, rendezvousBaseUrl: '', rendezvousPrefix: '', builtin: false,
  }

  let hostAvailable = false
  try {
    hostAvailable = !!(await probeHostPeering())
  } catch {
    hostAvailable = false // fail safe — never let a probe throw escape here
  }
  if (hostAvailable) {
    return { ...none, transport: TRANSPORT_HOST_PEERING }
  }

  let url = ''
  try {
    const resolved = await resolveRendezvous()
    url = typeof resolved === 'string' ? resolved : ''
  } catch {
    url = '' // fail safe — an unresolvable rendezvous means local-only, not a throw
  }
  if (url) {
    // Straight at the operator's chosen relay: no Diwan origin in the discovery
    // path.
    return {
      transport: TRANSPORT_RENDEZVOUS,
      rendezvousBaseUrl: url.replace(/\/+$/, ''),
      rendezvousPrefix: RENDEZVOUS_PREFIX,
      builtin: false,
    }
  }

  // The default: this server's own surface, same-origin.
  let prefix = ''
  try {
    const resolved = await resolveBuiltinPrefix()
    prefix = typeof resolved === 'string' ? resolved : ''
  } catch {
    prefix = ''
  }
  // A prefix must be an absolute PATH on this origin. Anything else — an absolute
  // URL, a scheme-relative `//host`, a relative segment — is refused rather than
  // pasted onto our origin: a server that reported something odd must degrade to
  // local-only, never redirect discovery somewhere unintended.
  if (!prefix || !prefix.startsWith('/') || prefix.startsWith('//') || !origin) {
    return none
  }
  return {
    transport: TRANSPORT_RENDEZVOUS,
    rendezvousBaseUrl: origin.replace(/\/+$/, ''),
    rendezvousPrefix: prefix.replace(/\/+$/, ''),
    builtin: true,
  }
}
