// no-broker-dep:allow-file: names Pier once, describing unchanged default behaviour when a
// Vulos OS/Pier host is in front of Diwan — an optional case in the priority chain
// transportSelection.js implements, not a default or an import.
/**
 * src/lib/crdt/yP2PSession.js — Yjs document sync over the E2E-encrypted P2P
 * room (the invite-link collaboration path, WAVE-25).
 *
 * Structurally the same session as before — same FabricClient transport, same
 * room derivation, the same AES-256-GCM sealed frames and the same rw/ro
 * capability gate (p2pRoom.js) — with the plain-text RGA CRDT replaced by Yjs.
 * The relay stays content-blind: it routes ciphertext and never sees a document.
 *
 * Wire vocabulary (inside the sealed frame):
 *   { type:'yu',       u:<b64 update> }   authoritative document update (rw only)
 *   { type:'ysync-req', sv:<b64 state vector> }  "send me what I'm missing"
 *   { type:'ysync',    u:<b64 diff> }     the answer (rw peers only, for rw peers)
 *
 * Why a state vector rather than the old snap/snap-req: Yjs can compute exactly
 * the delta a peer lacks (Y.encodeStateAsUpdate(doc, theirStateVector)), so a
 * reconnecting peer gets precisely its missing edits — no whole-document
 * snapshot, and no possibility of the old "whoever has more nodes wins" merge
 * that silently dropped a peer's offline work. Yjs merges are a union: two peers
 * that both edited offline both keep their edits.
 *
 * RO ENFORCEMENT is unchanged in spirit: a read-only peer holds no RW-MAC key,
 * so its frames are not authoritative, and an rw peer refuses to merge a
 * non-authoritative document frame. A ro peer therefore renders live edits but
 * can never write into the shared document.
 *
 * FAIL-CLOSED INGRESS: a peer inside the room is still untrusted (the key may
 * have been forwarded to anyone). Every inbound update goes through the same
 * validated apply as the server path — decode, try on a shadow doc, convert to a
 * ProseMirror document against the real schema, clamp images/links — and is
 * dropped if it would produce something unrenderable or unsafe.
 */

import * as Y from 'yjs'
import { FabricClient } from '../collab/webrtc/fabric.js'
import {
  parseInvite, generateInvite, deriveRoomKeys,
  sealFrame, openFrame, CAP_RW, CAP_RO,
} from './p2pRoom.js'
import {
  REMOTE_ORIGIN,
  MAX_SNAPSHOT_BYTES,
  bytesToB64,
  b64ToBytes,
  encodeUpdateEnvelope,
  decodeUpdateEnvelope,
  applyRemoteUpdate,
} from './ydoc.js'

export class YP2PCollabSession extends EventTarget {
  /**
   * @param {object} opts
   * @param {object} opts.room    { encKey, macKeyRw|null, roomId }
   * @param {'rw'|'ro'} opts.cap
   * @param {string} opts.peerId
   * @param {string} opts.fileId
   * @param {object} opts.ctx     { ydoc, shadow, schema } from createYContext()
   * @param {string} [opts.rendezvousBaseUrl]  base URL of any vulos-relayd's
   *   OPEN rendezvous surface (see transportSelection.js). When set, the
   *   underlying FabricClient runs its whole signaling lifecycle against that
   *   relayd instead of the host box's `/api/peering/*` — no Vulos OS / host
   *   box required for a REAL P2P session. Ignored when `fabric` is injected.
   * @param {FabricClient} [opts.fabric]  inject a transport (tests)
   */
  constructor({
    room, cap, peerId, fileId, ctx,
    signalingUrl, iceUrl, relayBaseUrl, authToken, rendezvousBaseUrl, rendezvousPrefix, fabric,
  }) {
    super()
    if (!room || !room.encKey) throw new Error('YP2PCollabSession: missing room keys')
    if (cap !== CAP_RW && cap !== CAP_RO) throw new Error(`YP2PCollabSession: bad cap "${cap}"`)
    // A context must carry a Y.Doc AND a way to validate an untrusted peer's
    // update fail-closed: either a ProseMirror `schema` (the default document
    // path, validated by applyRemoteUpdate) OR its own `applyUpdate` validator
    // (e.g. the whiteboard's Excalidraw-scene validator — see boardYdoc.js).
    // This is what lets the SAME encrypted P2P transport carry either a text
    // document or a whiteboard without a second collab stack.
    if (!ctx || !ctx.ydoc || (!ctx.schema && typeof ctx.applyUpdate !== 'function')) {
      throw new Error('YP2PCollabSession: missing Y context')
    }

    this._room = room
    this._cap = cap
    this._peerId = peerId
    this._fileId = fileId || room.roomId
    this._ctx = ctx
    this._joined = false
    this.rejectedUpdates = 0

    if (fabric) {
      this._fabric = fabric
    } else {
      const wsBase =
        signalingUrl ||
        (typeof window !== 'undefined'
          ? window.location.origin.replace(/^http/, 'ws') + '/api/peering/stream'
          : 'ws://localhost:8080/api/peering/stream')
      this._fabric = new FabricClient({
        sessionId: room.roomId,
        peerId,
        signalingUrl: wsBase,
        iceUrl: iceUrl || '/api/peering/ice',
        relayBaseUrl: relayBaseUrl || '',
        authToken: authToken || null,
        // Non-empty only in rendezvous mode (see transportSelection.js): the
        // FabricClient then runs offer/answer/ICE against this relayd's open
        // surface and ignores signalingUrl/iceUrl above.
        rendezvousBaseUrl: rendezvousBaseUrl || '',
        // Same-origin proxy mount (see transportSelection.js); the relay's own
        // default is used when a caller passes nothing.
        ...(rendezvousPrefix ? { rendezvousPrefix } : {}),
      })
    }

    this._fabric.addEventListener('state', (ev) => {
      this.dispatchEvent(new CustomEvent('state', { detail: ev.detail }))
      // RESYNC ON REACHABILITY (not on join()).
      //
      // join() fires its state-vector request immediately, but at that moment no
      // peer transport exists yet: a WebRTC data channel takes seconds of ICE to
      // open, and FabricClient DROPS anything sent to a peer that is still
      // 'connecting' (its own comment says "caller should buffer"). So the
      // join-time request reached nobody, and nothing re-sent it — two peers who
      // opened the same room and then sat idle never converged, and a late
      // joiner never received the existing document at all. Sync only appeared
      // to work if someone happened to type AFTER the channel opened.
      //
      // Found by the real-transport E2E (e2e-p2p/), invisible to the unit tests
      // because an injected fake fabric is connected the instant it is created.
      //
      // Fix: ask each peer for what we lack the moment that peer becomes
      // reachable — over a direct channel ('connected') or the content-blind
      // relay circuit ('relay'). It is idempotent (the answer is a delta
      // computed from OUR state vector, and merging can only add), so a
      // re-connect or a duplicate event costs one small frame.
      const { peerId, state } = ev.detail || {}
      if (!peerId) return
      if (state !== 'connected' && state !== 'relay') return
      this._resyncWith(peerId).catch(() => { /* peer vanished again — next event retries */ })
    })
    this._fabric.addEventListener('message', (ev) => {
      this._onPeerFrame(ev.detail).catch(() => { /* undecryptable frame — drop */ })
    })

    // Broadcast every LOCAL document change (never an echo of a remote one).
    // A ro peer emits nothing: its frames would carry no RW-MAC and be refused
    // by rw peers anyway, so we make the local editor honest instead of letting
    // it diverge silently.
    this._onLocalUpdate = (update, origin) => {
      if (origin === REMOTE_ORIGIN) return
      if (this.readOnly) return
      this._broadcast({ type: 'yu', u: bytesToB64(update) }, { authoritative: true })
        .catch(() => { /* transport down — peers resync on reconnect */ })
    }
    ctx.ydoc.on('update', this._onLocalUpdate)
  }

  // ── factories ─────────────────────────────────────────────────────────────

  static async fromInvite({ inviteLink, peerId, fileId, ctx, ...rest }) {
    const { roomId, cap, roomKey } = await parseInvite(inviteLink)
    const keys = await deriveRoomKeys(roomKey)
    // A ro peer must NOT hold macKeyRw — that is what stops it forging an
    // authoritative document frame.
    const room = cap === CAP_RO
      ? { encKey: keys.encKey, macKeyRw: null, roomId }
      : { encKey: keys.encKey, macKeyRw: keys.macKeyRw, roomId }
    return new YP2PCollabSession({ room, cap, peerId, fileId: fileId || roomId, ctx, ...rest })
  }

  static async create({ peerId, fileId, baseUrl, ctx, ...rest }) {
    const rw = await generateInvite({ cap: CAP_RW, baseUrl })
    const ro = await generateInvite({ cap: CAP_RO, baseUrl, roomKey: rw.roomKey })
    const keys = await deriveRoomKeys(rw.roomKey)
    const room = { encKey: keys.encKey, macKeyRw: keys.macKeyRw, roomId: keys.roomId }
    const session = new YP2PCollabSession({
      room, cap: CAP_RW, peerId, fileId: fileId || keys.roomId, ctx, ...rest,
    })
    return { session, rwLink: rw.link, roLink: ro.link, roomId: keys.roomId }
  }

  // ── public API ────────────────────────────────────────────────────────────

  get cap() { return this._cap }
  get roomId() { return this._room.roomId }
  get readOnly() { return this._cap === CAP_RO }
  get fabric() { return this._fabric }

  async join() {
    if (this._joined) return
    this._joined = true
    await this._fabric.join()
    await this.resync()
  }

  /**
   * Ask peers for whatever this document is missing. Safe to call repeatedly
   * (e.g. after a transport reconnect): the answer is a delta computed from OUR
   * state vector, and merging it can only ever add — a peer's offline edits are
   * never dropped, and our own are never overwritten.
   */
  async resync() {
    const sv = Y.encodeStateVector(this._ctx.ydoc)
    await this._broadcast({ type: 'ysync-req', sv: bytesToB64(sv) })
  }

  /**
   * Same as resync(), addressed to ONE peer. Used when that peer becomes
   * reachable (see the 'state' handler in the constructor) so the exchange
   * happens when there is actually a transport to carry it.
   * @param {string} peerId
   */
  async _resyncWith(peerId) {
    const sv = Y.encodeStateVector(this._ctx.ydoc)
    await this._sendTo(peerId, { type: 'ysync-req', sv: bytesToB64(sv) })
  }

  leave() {
    this._joined = false
    try { this._ctx.ydoc.off('update', this._onLocalUpdate) } catch { /* already gone */ }
    this._fabric.leave()
  }

  // ── inbound ───────────────────────────────────────────────────────────────

  async _onPeerFrame({ from, data }) {
    const frameB64 = typeof data === 'string' ? data : new TextDecoder().decode(data)
    // openFrame throws on wrong-key / tamper (AEAD): the relay and any uninvited
    // peer can never reach past this line. `authoritative` is true iff a valid
    // RW-MAC was present AND we hold macKeyRw to verify it (i.e. we are rw).
    const { msg, authoritative } = await openFrame(this._room, frameB64)
    if (!msg || typeof msg !== 'object') return

    if (msg.type === 'yu' || msg.type === 'ysync') {
      // RO ENFORCEMENT (rw side): only merge document frames that carry a valid
      // RW-MAC. A ro peer that tries to write emits a non-authoritative frame and
      // it is refused here, so its edits never enter the shared document. (A ro
      // RECEIVER holds no macKeyRw and cannot verify anyone; it merges what it is
      // given, which is contained to its own read-only view.)
      if (this._room.macKeyRw && !authoritative) return
      const max = msg.type === 'ysync' ? MAX_SNAPSHOT_BYTES : undefined
      const update = decodeUpdateEnvelope({ y: 1, u: msg.u }, max)
      if (!update) { this.rejectedUpdates++; return }
      // Validate + apply through the context's own fail-closed validator when it
      // supplies one (whiteboard), otherwise the default ProseMirror-document
      // guard. Either way an untrusted peer's bytes are tried on a SHADOW doc
      // first and dropped if they would produce something unrenderable/unsafe.
      const apply = typeof this._ctx.applyUpdate === 'function'
        ? this._ctx.applyUpdate
        : applyRemoteUpdate
      const res = apply(this._ctx, update)
      if (!res.applied) {
        this.rejectedUpdates++
        console.warn('[y-p2p] rejected a peer update (fail-closed):', res.reason)
        return
      }
      this.dispatchEvent(new CustomEvent('change', { detail: { remote: true } }))
      return
    }

    if (msg.type === 'ysync-req') {
      // Answer with exactly what the asking peer lacks. Only an rw peer serves an
      // AUTHORITATIVE answer, so a ro peer cannot seed a poisoned document into
      // an rw peer.
      const sv = b64ToBytes(msg.sv)
      if (!sv) return
      let diff
      try {
        diff = Y.encodeStateAsUpdate(this._ctx.ydoc, sv)
      } catch {
        return // malformed state vector — drop
      }
      if (!diff || diff.length === 0) return
      if (diff.length > MAX_SNAPSHOT_BYTES) return
      await this._sendTo(from, { type: 'ysync', u: bytesToB64(diff) }, { authoritative: !this.readOnly })
    }
  }

  // ── outbound (sealed) ─────────────────────────────────────────────────────

  async _broadcast(msg, opts) {
    const frame = await sealFrame(this._room, msg, opts)
    this._fabric.send(frame)
  }

  async _sendTo(peerId, msg, opts) {
    const frame = await sealFrame(this._room, msg, opts)
    if (peerId) this._fabric.sendTo(peerId, frame)
    else this._fabric.send(frame)
  }
}

// Re-exported so callers building a room by hand keep one import site.
export { encodeUpdateEnvelope }
