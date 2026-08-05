// no-broker-dep:allow-file: names Pier once, describing unchanged default behaviour when a
// Vulos OS/Pier host is in front of Diwan — an optional case in the priority chain
// transportSelection.js implements, not a default or an import.
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
 *          Pier in front of Diwan). Unchanged default.
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

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type * as Y from 'yjs'
import type { Schema } from '@tiptap/pm/model'
import { YP2PCollabSession, type AnyYContext } from '../../lib/crdt/yP2PSession.js'
import type { BoardYContext } from '../../lib/crdt/boardYdoc.js'
import type { RoomCap } from '../../lib/crdt/p2pRoom.js'
import { resolveReachableBase } from '../../lib/collab/reachableBase.js'
import {
  selectCollabTransport,
  TRANSPORT_LOCAL_ONLY,
} from '../../lib/collab/transportSelection.js'

type PeerState = string

interface P2PLinks {
  rwLink: string
  roLink: string
}

/**
 * The Y context DocsEditor builds via `createYContext(null, ydoc)` and mutates
 * IN PLACE once the ProseMirror editor mounts (`yctx.schema = editor.schema`;
 * see DocsEditor.tsx, which imports this exact type rather than redeclaring
 * it). `schema` therefore starts `null` on the very same object this hook
 * holds a reference to, which is exactly the race ctxReady/waitForCtx below
 * exist to handle — this hook cannot just take `AnyYContext` from ydoc.ts's
 * `YContext` (which requires a non-null `schema`) at its own boundary.
 */
export type DocsYContext = { ydoc: Y.Doc; shadow: Y.Doc; schema: Schema | null }

/**
 * This hook is shared verbatim by Docs (ProseMirror, `DocsYContext` above —
 * schema starts `null` and is attached post-mount) and the whiteboard
 * (Excalidraw, `BoardYContext` — no `schema` at all, validation goes through
 * `applyUpdate` instead; see boardYdoc.ts). Both are accepted here structurally
 * and handed to `YP2PCollabSession` as `AnyYContext` once ctxReady/waitForCtx
 * confirm the object is complete for its shape.
 */
type HookYContext = DocsYContext | BoardYContext

type ShareResult = { rwLink: string; roLink: string; roomId: string }

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
 * True when a Y context is COMPLETE enough for a session: a Y.Doc plus a way to
 * validate an untrusted peer's update fail-closed — a ProseMirror `schema` (the
 * document path) or the caller's own `applyUpdate` validator (the whiteboard's
 * Excalidraw-scene path). Mirrors the check YP2PCollabSession's constructor makes.
 */
// `ctx` is a mutable object built up in place by the caller (DocsEditor attaches
// `schema` after mount — see waitForCtx below), so at the moment this runs it may
// not yet satisfy AnyYContext even though the hook's declared ctx type says it
// will. Checked as `unknown` rather than trusted from the type, which is the
// whole point of this guard.
function ctxReady(ctx: unknown): ctx is AnyYContext {
  if (!ctx || typeof ctx !== 'object') return false
  const c = ctx as { ydoc?: unknown; schema?: unknown; applyUpdate?: unknown }
  return !!c.ydoc && (!!c.schema || typeof c.applyUpdate === 'function')
}

/**
 * Wait until `ctx` is complete, or give up after `timeoutMs`.
 *
 * WHY THIS EXISTS — a real race, observed. DocsEditor creates its Y context as
 * soon as it has a Y.Doc, but attaches `schema` only once the ProseMirror editor
 * has MOUNTED (`yctx.schema = editor.schema`). So there is a window where `ctx` is
 * truthy but incomplete. The auto-join effect below fires on `ctx` becoming
 * truthy; if it won that race it constructed a session with a half-built context,
 * which threw `missing Y context` — and the catch tore the session down for good.
 * The user got an invite link that silently never connected, with only a console
 * warning, and whether it happened depended on how long the transport probe took.
 *
 * The context object is mutated in place rather than replaced, so no React state
 * changes when `schema` lands and no dependency array can express "wait for it".
 * Polling the object is therefore the honest fix, not a workaround.
 *
 * Bounded, so a genuinely broken context still fails (loudly, as before) instead
 * of hanging the join forever.
 */
function waitForCtx(
  ctx: HookYContext | null | undefined,
  { timeoutMs = 15_000, intervalMs = 50 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  if (ctxReady(ctx)) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      if (ctxReady(ctx)) return resolve(true)
      if (Date.now() > deadline) return resolve(false)
      setTimeout(tick, intervalMs)
    }
    setTimeout(tick, intervalMs)
  })
}

export interface UseP2PCollabOptions {
  fileId: string
  /** { ydoc, shadow, schema } (createYContext); `schema` may still be `null`
   *  until the ProseMirror editor mounts — see DocsYContext above. Or, from
   *  the whiteboard, a `BoardYContext` ({ ydoc, shadow, applyUpdate }) —
   *  see HookYContext. */
  ctx: HookYContext | null
  autoJoinFromLink?: boolean
  /** master switch (VITE_DOCS_COLLAB) */
  enabled?: boolean
}

export interface UseP2PCollabResult {
  active: boolean
  cap: RoomCap | null
  readOnly: boolean
  roomId: string | null
  peers: Record<string, PeerState>
  peerCount: number
  links: P2PLinks | null
  peeringUnavailable: boolean
  collabDisabled: boolean
  inviteIgnored: boolean
  startShare: () => Promise<ShareResult>
  rotate: () => Promise<ShareResult>
  leave: () => void
  session: RefObject<YP2PCollabSession | null>
}

export function useP2PCollab({
  fileId, ctx, autoJoinFromLink = true, enabled = true,
}: UseP2PCollabOptions): UseP2PCollabResult {
  const [active, setActive] = useState(false)
  const [cap, setCap] = useState<RoomCap | null>(null)
  const [roomId, setRoomId] = useState<string | null>(null)
  const [peers, setPeers] = useState<Record<string, PeerState>>({})   // peerId → state
  const [links, setLinks] = useState<P2PLinks | null>(null)           // { rwLink, roLink } when sharing
  const [peeringUnavailable, setPeeringUnavailable] = useState(false)
  const sessionRef = useRef<YP2PCollabSession | null>(null)

  const wireSession = useCallback((session: YP2PCollabSession) => {
    session.addEventListener('state', (ev) => {
      const { peerId, state } = (ev as CustomEvent<{ peerId: string; state: string }>).detail
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

    // Never rejects: selectCollabTransport and waitForCtx both fail-safe
    // internally (resolve false/local-only rather than throw), and the one
    // call that can throw (YP2PCollabSession.fromInvite/.join) has its own
    // try/catch below.
    void (async () => {
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
      // The editor may not have attached its ProseMirror schema to `ctx` yet —
      // see waitForCtx. Joining with a half-built context throws and the catch
      // below would tear the session down permanently, leaving the user on an
      // invite link that never connects.
      if (!(await waitForCtx(ctx))) {
        console.warn('[p2p] invite link opened, but the document context never became ' +
          'ready (no Y.Doc + schema) — not joining rather than joining something ' +
          'that cannot validate a remote update.')
        if (!cancelled) teardown()
        return
      }
      if (cancelled) return
      try {
        // waitForCtx just confirmed ctxReady(ctx) above (that's the only way it
        // resolves true) — ctx is a complete AnyYContext at this point, just not
        // narrowed as such since the check happened inside that call.
        const session = await YP2PCollabSession.fromInvite({
          inviteLink, peerId, fileId, ctx: ctx as AnyYContext, rendezvousBaseUrl, rendezvousPrefix,
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
        console.warn('[p2p] join from link failed:', (err as Error)?.message)
        if (!cancelled) teardown()
      }
    })()

    return () => { cancelled = true }
  }, [enabled, ctx, autoJoinFromLink, fileId, wireSession, teardown])

  // ── SHARE: mint a fresh room and expose rw/ro links ────────────────────────
  const startShare = useCallback(async (): Promise<ShareResult> => {
    // Co-editing disabled for this deployment: refuse to mint a room rather than
    // hand the user links that would look real and never sync anything.
    if (!enabled) throw new Error('collab-disabled')
    if (!ctx) throw new Error('document not ready')
    // Same race as the join path (see waitForCtx): the schema is attached when the
    // editor mounts, and a user can reach the share button before that has landed
    // on a slow first paint. Waiting beats throwing a confusing error at someone
    // whose document is a moment from ready.
    if (!(await waitForCtx(ctx))) throw new Error('document not ready')

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
    // waitForCtx just confirmed ctxReady(ctx) above — see the matching comment
    // on the join path.
    const { session, rwLink, roLink, roomId: rid } = await YP2PCollabSession.create({
      peerId, fileId, baseUrl, ctx: ctx as AnyYContext, rendezvousBaseUrl, rendezvousPrefix,
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
