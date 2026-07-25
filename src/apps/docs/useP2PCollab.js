/**
 * useP2PCollab — React hook wiring the secure P2P collab session (WAVE-25) into
 * the Docs editor's Y.Doc.
 *
 * Two entry points:
 *   • JOIN: the current URL carries a `#vp2p=…` invite fragment → join that room
 *     (rw or ro per the invite's capability). This is what opening a shared link
 *     does.
 *   • SHARE: the user clicks "Collaborate via link" → create() a fresh room and
 *     surface rw/ro links (see startShare()).
 *
 * The document syncs as Yjs updates inside the room's end-to-end-encrypted frames
 * (see lib/crdt/yP2PSession.js), so formatting and structure propagate and the
 * relay stays content-blind. There is no text-diff contract any more: the editor's
 * Y.Doc IS the document, and the session simply carries its updates.
 *
 * HONESTY GUARDS — three-way reality (see docs/COLLABORATION.md §3):
 *   • Live co-editing can be gated off for the whole deployment (`enabled`, from
 *     VITE_DOCS_COLLAB). Then this hook is inert: no invite is joined, no room is
 *     minted, nothing is sent or applied — and `collabDisabled` / `inviteIgnored`
 *     let the caller SAY so instead of showing affordances that do nothing.
 *   • Otherwise, both entry points resolve transportSelection.js's three-way
 *     choice BEFORE touching the fabric:
 *       1. HOST-BOX PEERING — this server mounts `/api/peering/*` (Vulos OS /
 *          Ephor in front of Ofisi). Unchanged default.
 *       2. ANY RELAYD RENDEZVOUS — no host-box peering, but a rendezvous URL is
 *          configured (config.yaml `collab.rendezvous_url` /
 *          VULOS_RENDEZVOUS_URL). The invite-link session then runs entirely
 *          against that relayd — no Vulos OS / host box required. THE PAYOFF:
 *          a standalone Office binary (no `/api/peering/*` at all, see main.go)
 *          gets a REAL P2P session, not a false "Live".
 *       3. LOCAL-ONLY — neither is available: an invite link cannot connect
 *          anyone, so `peeringUnavailable` is surfaced instead of failing
 *          silently, and startShare() rejects rather than minting links that
 *          will never sync.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { YP2PCollabSession } from '../../lib/crdt/yP2PSession.js'
import { resolveReachableBase } from '../../lib/collab/reachableBase.js'
import {
  selectCollabTransport,
  TRANSPORT_LOCAL_ONLY,
} from '../../lib/collab/transportSelection.js'

/** True when the current location carries a P2P invite fragment. */
export function hasInviteInLocation() {
  if (typeof window === 'undefined') return false
  return /(?:^|[#&?])vp2p=/.test(window.location.hash || '')
}

function getOrCreatePeerId() {
  try {
    let id = sessionStorage.getItem('vulos_peer_id')
    if (!id) { id = crypto.randomUUID(); sessionStorage.setItem('vulos_peer_id', id) }
    return id
  } catch {
    return crypto.randomUUID()
  }
}

/**
 * @param {object} opts
 * @param {string} opts.fileId
 * @param {object} opts.ctx  { ydoc, shadow, schema } (createYContext)
 * @param {boolean} [opts.autoJoinFromLink=true]
 * @param {boolean} [opts.enabled=true]  master switch (VITE_DOCS_COLLAB)
 */
export function useP2PCollab({ fileId, ctx, autoJoinFromLink = true, enabled = true }) {
  const [active, setActive] = useState(false)
  const [cap, setCap] = useState(null)          // 'rw' | 'ro'
  const [roomId, setRoomId] = useState(null)
  const [peers, setPeers] = useState({})        // peerId → state
  const [links, setLinks] = useState(null)      // { rwLink, roLink } when sharing
  const [peeringUnavailable, setPeeringUnavailable] = useState(false)
  const sessionRef = useRef(null)

  const wireSession = useCallback((session) => {
    session.addEventListener('state', (ev) => {
      const { peerId, state } = ev.detail
      setPeers((prev) => ({ ...prev, [peerId]: state }))
    })
  }, [])

  const teardown = useCallback(() => {
    if (sessionRef.current) {
      try { sessionRef.current.leave() } catch { /* ignore */ }
      sessionRef.current = null
    }
    setActive(false)
    setCap(null)
    setRoomId(null)
    setPeers({})
    setLinks(null)
  }, [])

  // ── auto-join when the URL carries an invite fragment ──────────────────────
  useEffect(() => {
    if (!enabled) return          // co-editing disabled → never touch the fabric
    if (!ctx) return              // no document to sync yet
    if (!autoJoinFromLink) return
    if (!hasInviteInLocation()) return
    let cancelled = false
    const peerId = getOrCreatePeerId()
    const inviteLink = window.location.href

    ;(async () => {
      // Resolve the three-way transport BEFORE touching the fabric: a
      // standalone server never mounts /api/peering/*, but a configured
      // rendezvous URL still gets a real session — only true local-only fails.
      const { transport, rendezvousBaseUrl, rendezvousPrefix } = await selectCollabTransport()
      if (cancelled) return
      if (transport === TRANSPORT_LOCAL_ONLY) {
        console.warn('[p2p] invite link opened, but this server has no reachable ' +
          'collaboration transport (no /api/peering/*, and no rendezvous URL configured) ' +
          '— a standalone Office binary cannot make a P2P connection. Staying in local/cloud mode.')
        setPeeringUnavailable(true)
        return
      }
      try {
        const session = await YP2PCollabSession.fromInvite({
          inviteLink, peerId, fileId, ctx, rendezvousBaseUrl, rendezvousPrefix,
        })
        if (cancelled) { session.leave(); return }
        wireSession(session)
        sessionRef.current = session
        setCap(session.cap)
        setRoomId(session.roomId)
        setActive(true)
        await session.join()
      } catch (err) {
        // A malformed/tampered invite fails closed — we simply don't enter P2P
        // mode (the editor stays in normal local/cloud mode).
        console.warn('[p2p] join from link failed:', err?.message)
        if (!cancelled) teardown()
      }
    })()

    return () => { cancelled = true }
  }, [enabled, ctx, autoJoinFromLink, fileId, wireSession, teardown])

  // ── SHARE: mint a fresh room and expose rw/ro links ────────────────────────
  const startShare = useCallback(async () => {
    // Co-editing disabled for this deployment: refuse to mint a room rather than
    // hand the user links that would look real and never sync anything.
    if (!enabled) throw new Error('collab-disabled')
    if (!ctx) throw new Error('document not ready')

    // Resolve BEFORE minting a room: on a bare standalone server (no host-box
    // peering AND no rendezvous URL configured) the room's invite links would
    // look real but never connect anyone.
    const { transport, rendezvousBaseUrl, rendezvousPrefix } = await selectCollabTransport()
    if (transport === TRANSPORT_LOCAL_ONLY) {
      setPeeringUnavailable(true)
      throw new Error('peering-unavailable')
    }
    setPeeringUnavailable(false)

    if (sessionRef.current) {
      try { sessionRef.current.leave() } catch { /* ignore */ }
      sessionRef.current = null
    }
    const peerId = getOrCreatePeerId()
    // NAT reachability: build the invite base from Office's externally-reachable
    // origin so a link handed to an EXTERNAL peer targets a URL they can reach.
    const reachable = await resolveReachableBase()
    const pathname = typeof window !== 'undefined' && window.location
      ? window.location.pathname
      : '/'
    const originBase = reachable || (typeof window !== 'undefined' ? window.location.origin : '')
    const baseUrl = originBase ? `${originBase}${pathname}` : undefined
    const { session, rwLink, roLink, roomId: rid } = await YP2PCollabSession.create({
      peerId, fileId, baseUrl, ctx, rendezvousBaseUrl, rendezvousPrefix,
    })
    wireSession(session)
    sessionRef.current = session
    setCap('rw')
    setRoomId(rid)
    setLinks({ rwLink, roLink })
    setActive(true)
    await session.join()
    return { rwLink, roLink, roomId: rid }
  }, [enabled, ctx, fileId, wireSession])

  /** Rotate the room key (revoke old links) by minting a brand-new room. */
  const rotate = useCallback(async () => startShare(), [startShare])

  // Cleanup on unmount.
  useEffect(() => () => teardown(), [teardown])

  const readOnly = cap === 'ro'
  const peerCount = Object.values(peers).filter((s) => s === 'connected' || s === 'relay').length

  return {
    active, cap, readOnly, roomId, peers, peerCount, links, peeringUnavailable,
    // True when live co-editing is disabled for this build (VITE_DOCS_COLLAB=off).
    // Callers MUST surface this rather than showing an inert share affordance.
    collabDisabled: !enabled,
    // True when someone opened an invite link but co-editing is disabled — the
    // link cannot connect them and we owe them an explicit message.
    inviteIgnored: !enabled && hasInviteInLocation(),
    startShare, rotate, leave: teardown,
    session: sessionRef,
  }
}
