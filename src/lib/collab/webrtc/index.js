/**
 * src/lib/collab/webrtc/index.js — Diwan's first-party P2P collaboration
 * transport (direct WebRTC first, content-blind relay circuit fallback only
 * on hard NAT, optional rendezvous discovery against a self-hosted relayd).
 *
 * Re-homed from the vendored `relay-client` package so Diwan no longer
 * depends on that other product's package — see docs/COLLABORATION.md §3 and
 * docs/COTURN.md (self-hosting TURN for symmetric-NAT peers). Endpoint
 * failover (`selectEndpoint` et al) and offline-shell bootstrap are a
 * different, non-P2P concern and live in `src/lib/endpoints/` instead.
 *
 *   import { FabricClient } from './fabric.js'          // tree-shake
 *   import { usePresence }  from './presence.js'
 *   import { useLiveCursors } from './useLiveCursors.js'
 *
 * Only the modules Diwan actually uses are re-homed here (this SDK shipped
 * additional subpaths — a health-check export, region-aware PoP selection,
 * audio/video calling signaling — that Diwan never imported; they were
 * dropped rather than carried along as dead weight).
 */

export * from './errors.js'
export * from './signaling.js'
export * from './fabric.js'
export * from './rendezvous.js'
export * from './rendezvousSignaling.js'
export * from './prekeys.js'
export * from './presence.js'
export * from './useLiveCursors.js'
