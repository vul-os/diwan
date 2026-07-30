/**
 * src/lib/collab/presenceCommon.js — shared collaboration-presence helpers
 * (WAVE-27).
 *
 * Sheets and Slides gained live presence (roster + cursors + status pill) by
 * reusing the exact same first-party WebRTC fabric that Docs uses (see
 * src/lib/collab/webrtc/). To avoid copying
 * the identity / colour / status-mapping logic into three editors, the pure,
 * transport-agnostic pieces live here and are unit-tested in isolation.
 *
 * Nothing in this module opens a socket or touches React — it is deliberately
 * pure so the status-pill and roster projection can be tested without a DOM or
 * a live fabric. The FabricClient lifecycle itself is owned by each editor (via
 * the CRDT session's `.fabric`, mirroring YP2PCollabSession).
 */

import { peerColor } from './webrtc/useLiveCursors.js'

/**
 * Derive a stable local collaborator identity, mirroring the approach used in
 * DocsEditor: prefer a signed-in Vulos account (persisted under
 * `presence_identity`), otherwise fall back to a per-tab guest identity keyed
 * off the CRDT peer/replica id so a peer keeps a consistent colour + label.
 *
 * @param {string} [fallbackPeerId] stable per-tab id (e.g. the CRDT replicaId)
 * @returns {{ accountId: string, displayName: string, isGuest?: boolean }}
 */
export function getCollabIdentity(fallbackPeerId) {
  // Guard for non-DOM (test / SSR) environments.
  const ls = typeof localStorage !== 'undefined' ? localStorage : null
  const ss = typeof sessionStorage !== 'undefined' ? sessionStorage : null

  try {
    const raw = ls?.getItem('presence_identity')
    const parsed = raw ? JSON.parse(raw) : null
    if (parsed && parsed.accountId) {
      return {
        accountId: parsed.accountId,
        displayName: parsed.displayName || 'Me',
      }
    }
  } catch {
    /* corrupt identity blob — fall through to guest */
  }

  const peerId = fallbackPeerId
    || ss?.getItem('vulos_peer_id')
    || ss?.getItem('crdt_grid_replica')
    || ss?.getItem('crdt_tree_replica')
    || 'local'

  return {
    accountId: `guest:${peerId}`,
    displayName: 'Me',
    isGuest: true,
  }
}

/**
 * Peer colour for the local caret/selection + avatar, derived from accountId.
 * Uses the relay-client `peerColor` so the local user's colour matches the one
 * remote peers compute for them (identical hash → identical hue).
 *
 * @param {{ accountId?: string } | null} identity
 * @returns {string} CSS colour
 */
export function identityColor(identity) {
  return peerColor(identity?.accountId)
}

// ─── Status-pill state machine ────────────────────────────────────────────────

/** Peer connection states the fabric reports that count as "reachable". */
const LIVE_PEER_STATES = new Set(['connected', 'relay'])

/** Peer states that mean "still trying" (transient, not yet reachable). */
const PENDING_PEER_STATES = new Set(['new', 'connecting', 'reconnecting', 'checking'])

/**
 * Count peers that are actually reachable (direct WebRTC or via relay).
 * Mirrors the peerCount derivation in DocsEditor.
 *
 * @param {Record<string, string>} peers  peerId → state
 * @returns {number}
 */
export function countLivePeers(peers) {
  if (!peers) return 0
  return Object.values(peers).filter((s) => LIVE_PEER_STATES.has(s)).length
}

/**
 * Map raw collaboration signals to a status-pill descriptor. Pure — no React,
 * no fabric. The three inputs come from the editor:
 *   - configured: is a collab backend wired at all (fabric non-null)?
 *   - joined:     did the fabric's join() resolve (signaling up)?
 *   - peers:      peerId → state map from the fabric 'state' events
 *   - readOnly:   the local user only has view access (permission clarity)
 *   - engineMismatch: a peer is provably running a DIFFERENT CRDT engine, so
 *                 this session refused to keep replicating (see
 *                 lib/crdt/gridEngine.js)
 *
 * Returns { status, label, tone } where status ∈
 *   'offline' | 'connecting' | 'reconnecting' | 'live' | 'solo' | 'readonly'
 *   | 'mismatch'.
 *
 * Design intent (matches Docs' quiet, non-alarming status treatment):
 *   - 'solo'         — connected, no peers yet: “Live” but calm (no alarm).
 *   - 'live'         — ≥1 peer reachable.
 *   - 'connecting'   — fabric configured, join not yet resolved.
 *   - 'reconnecting' — was joined, but transport dropped / peers gone pending.
 *   - 'offline'      — no collab backend configured (solo local editing).
 *   - 'readonly'     — overlaid regardless of connection (permission clarity).
 *   - 'mismatch'     — the ONE state here that is genuinely an error rather than
 *                      a phase. Everything else on this list still converges
 *                      eventually; this one never will, and the transport is
 *                      still perfectly connected, so it would otherwise read as
 *                      "Live" forever. It therefore outranks every connection
 *                      state below it and is the only one with a danger tone.
 *
 * @param {object} opts
 * @param {boolean} opts.configured
 * @param {boolean} opts.joined
 * @param {Record<string, string>} [opts.peers]
 * @param {boolean} [opts.readOnly]
 * @param {boolean} [opts.engineMismatch]
 * @returns {{ status: string, label: string, tone: string }}
 */
export function deriveStatusPill({
  configured, joined, peers = {}, readOnly = false, engineMismatch = false,
} = {}) {
  if (engineMismatch) {
    // Ranked ABOVE readOnly and above every connection state: a view-only peer
    // in a mismatched room is still in a room that cannot converge, and the
    // fabric being healthy is exactly what makes this dangerous to under-report.
    return { status: 'mismatch', label: 'Not syncing', tone: 'danger' }
  }

  if (readOnly) {
    return { status: 'readonly', label: 'View only', tone: 'muted' }
  }

  if (!configured) {
    // No collab backend — pure local editing. We stay quiet ("Offline" here is
    // informational, not an error): the editor works fully, presence is just
    // empty. Tone is muted, never danger.
    return { status: 'offline', label: 'Offline', tone: 'muted' }
  }

  const live = countLivePeers(peers)
  if (live > 0) {
    return { status: 'live', label: 'Live', tone: 'success' }
  }

  const values = Object.values(peers)
  const anyPending = values.some((s) => PENDING_PEER_STATES.has(s))

  if (!joined) {
    return { status: 'connecting', label: 'Connecting…', tone: 'muted' }
  }

  if (anyPending) {
    // We were live (joined) but a peer dropped to a pending state → reconnecting.
    return { status: 'reconnecting', label: 'Reconnecting…', tone: 'warning' }
  }

  // Joined, no peers at all: solo but connected. Present as a calm "Live".
  return { status: 'solo', label: 'Live', tone: 'success' }
}
