// no-broker-dep:allow-file: implements the OPTIONAL external-relay transport (RendezvousURL,
// default empty — backend/config/config_test.go's TestDefault_RendezvousURLEmpty) that
// transportSelection.js only selects when an operator explicitly configures it; the built-in
// surface (backend/rendezvous) is the default and needs none of this.
//
// rendezvousSignaling.js — a drop-in signaling transport for FabricClient that
// runs the COMPLETE WebRTC signaling lifecycle (presence discovery + offer /
// answer / ICE exchange + polite-peer negotiation) over any vulos-relayd's OPEN
// rendezvous surface (announce / resolve / signal), with NO host box and no
// /api/peering/* backend. This is what unlocks OS-free P2P for standalone apps.
//
// It presents the SAME interface FabricClient already consumes from
// SignalingClient — the events `signal` / `signaling-open` / `signaling-close` /
// `offline`, the methods `connect()` / `close()` / `signal(type,to,data)`, and
// the peer-key helpers (`hasPeerKey`, `getPeerBoxKey`, `getPeerSignedPreKey`,
// `isPeerV2Capable`, `verifyPeerSignedPreKey`, `verifyPeerSig`) — so FabricClient
// is unchanged apart from choosing this transport when `rendezvousBaseUrl` is set.
//
// ── IDENTITY BRIDGING (two distinct, documented identities) ──────────────────
//
// Rendezvous WRITES are authenticated by an Ed25519 key (the rendezvous protocol
// signs every announce/deposit/poll). FabricClient's PEER handshake is
// authenticated by a per-session ECDSA-P256 key (offer/answer/ice sigs, TOFU
// pinning, X3DH prekeys). These stay SEPARATE:
//
//   • The Ed25519 rendezvous identity signs the OUTER rendezvous envelope
//     (accountability + replay protection at the relay). By default it is
//     EPHEMERAL per session — generated fresh alongside the ephemeral per-session
//     ECDSA key — which PRESERVES the current security model (FabricClient has no
//     persistent cross-session identity today; the ECDSA session key is also
//     ephemeral). A caller MAY inject a stable RendezvousIdentity to get a durable
//     rendezvous address; see FabricClient's `rendezvousIdentity` option.
//
//   • The ECDSA session pubkey rides INSIDE the opaque signal payload exactly as
//     over WebSocket (the `pubKey`/`depositPubKey`/`signedPreKey`/`sig` fields the
//     server never needed to understand). The end-to-end peer-auth handshake —
//     the thing that actually pins the DTLS fingerprint and blocks impersonation —
//     is therefore BYTE-FOR-BYTE identical to the host-box path (it runs through
//     the shared SignalingClient._processSignal / _buildSignalPayload code).
//
// The relay only ever moves opaque bytes keyed by Ed25519 public key; it cannot
// read or forge the inner handshake.
//
// ── DISCOVERY (session "room" board) ─────────────────────────────────────────
//
// Rendezvous is key-addressed point-to-point, so there is no server-side session
// room to broadcast joins into. We synthesise one: a DETERMINISTIC Ed25519 "room"
// identity is derived from the sessionId (every member computes the same key), and
// its signal inbox is used as a shared, content-blind PRESENCE BOARD. Each member
// deposits its signed `join` announcement (the same payload the WS path
// broadcasts, plus its own rendezvous address) onto the board and long-polls the
// board to discover peers; `signal` blobs (offer/answer/ice) are then addressed
// point-to-point to each peer's own rendezvous inbox. Board pickups are a
// non-destructive peek (the Go queue defers delete to ack), so every member sees
// every member's presence; heartbeats refresh it and a `leave` tombstone drops it.
//
// SECURITY NOTE (open mode): with no host-box JWT, a peerId is self-asserted and
// bound TOFU (first ECDSA key seen for a peerId wins) exactly as in the WS model —
// the difference is only that the boundary is "knows the sessionId" rather than
// "authenticated by the host". The real cryptographic identity is the pinned
// ECDSA key; the peerId↔rendezvous-key mapping is a routing hint the handshake
// does not trust. Use unguessable session ids for private rooms.

import { SignalingClient } from './signaling.js'
import { RendezvousClient, RendezvousIdentity, b64urlEncode } from './rendezvous.js'
import { sha256 } from '@noble/hashes/sha2.js'

// Domain-separated seed for the deterministic per-session room identity. Bump the
// version suffix if the derivation ever changes (it partitions the board space).
const ROOM_SEED_DOMAIN = 'vulos-rdv/room/1:'

// Cadence at which a member re-deposits its presence onto the board so late
// joiners discover it and it outlives the signal-queue TTL (default 2 min server
// side). Kept well under that TTL.
const HEARTBEAT_MS = 45_000
// Long-poll wait (seconds) requested from the relay; the server holds the request
// until a blob arrives or this elapses, so idle polling costs one blocked request.
const POLL_WAIT_S = 20
// Between two returned polls we wait this long before re-polling. In production
// the long-poll itself blocks, so this only throttles the (rare) fast-return case
// and the reconnect cadence; kept small for low signaling latency.
const POLL_GAP_MS = 250
// Reconnect backoff bounds when the relay is unreachable.
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
const RECONNECT_MAX_ATTEMPTS = 10
// Bounded set of already-processed board blob ids (peek returns them repeatedly).
const SEEN_BOARD_MAX = 2_000

/**
 * Derive the deterministic Ed25519 room identity for a sessionId. Every member of
 * the session computes the identical keypair, so its rendezvous inbox is a shared
 * discovery board. Not secret — knowing the sessionId is what grants membership.
 *
 * @param {string} sessionId
 * @returns {RendezvousIdentity}
 */
export function deriveRoomIdentity(sessionId) {
  const seed = sha256(new TextEncoder().encode(ROOM_SEED_DOMAIN + String(sessionId)))
  return new RendezvousIdentity(seed) // sha256 → 32 bytes = an Ed25519 secret
}

const utf8 = new TextEncoder()
const utf8dec = new TextDecoder()

export class RendezvousSignalingClient extends EventTarget {
  /**
   * @param {object} opts
   * @param {RendezvousClient} opts.selfClient - the caller's per-peer rendezvous
   *        client (its Ed25519 identity is this peer's rendezvous address). The
   *        room client is derived from it via withIdentity().
   * @param {string} opts.sessionId
   * @param {string} opts.peerId
   * @param {() => (string|null)} [opts.getDepositPubKey]
   * @param {() => (string|null)} [opts.getBoxPubKey]
   * @param {() => (object|null)} [opts.getSignedPreKey]
   * @param {((msg:string)=>Promise<string>)|null} [opts.signFrame]
   * @param {boolean} [opts.requirePeerAuth=true]
   * @param {number}  [opts.maxAttempts]
   * @param {boolean} [opts.pollLoop=true] - start the recurring long-poll timers on
   *        connect(). Tests set false and drive `_pollBoardOnce`/`_pollInboxOnce`.
   */
  constructor({
    selfClient,
    sessionId,
    peerId,
    getDepositPubKey = null,
    getBoxPubKey = null,
    getSignedPreKey = null,
    signFrame = null,
    requirePeerAuth = true,
    maxAttempts = RECONNECT_MAX_ATTEMPTS,
    pollLoop = true,
  }) {
    super()
    if (!(selfClient instanceof RendezvousClient)) {
      throw new TypeError('RendezvousSignalingClient: selfClient (RendezvousClient) is required')
    }
    this._self = selfClient
    this._room = selfClient.withIdentity(deriveRoomIdentity(sessionId))
    this._session = sessionId
    this._peerId = peerId
    this._signFrame = signFrame
    this._pollLoop = pollLoop
    this._maxAttempts = maxAttempts

    // The inert processing core: a SignalingClient we NEVER connect. We reuse its
    // transport-agnostic handshake pipeline (_processSignal), its signed payload
    // builders (_buildSignalPayload / _buildJoinPayload) and its peer-key registry
    // + verification helpers, so the peer-auth handshake is identical to the WS
    // path. authToken is null here, so its transport guard never fires (the
    // rendezvous auth token, if any, is enforced on selfClient instead).
    this._core = new SignalingClient({
      signalingUrl: 'wss://rendezvous.local/inert', // never dialed
      sessionId,
      peerId,
      authToken: null,
      getDepositPubKey,
      getBoxPubKey,
      getSignedPreKey,
      signFrame,
      requirePeerAuth,
    })
    // Surface the core's verified `signal` events to FabricClient unchanged.
    this._core.addEventListener('signal', (ev) => {
      this.dispatchEvent(new CustomEvent('signal', { detail: ev.detail }))
    })

    // peerId ↔ rendezvous address routing hints (learned from the board / inbox).
    /** @type {Map<string,string>} peerId → rendezvous key (base64url) */
    this._peerRdvKey = new Map()
    /** @type {Set<string>} peerIds we have already dispatched a `join` for */
    this._knownPeers = new Set()
    /** @type {Set<string>} processed board blob ids (bounded) */
    this._seenBoard = new Set()

    this._stopped = false
    this._open = false
    this._degraded = false
    this._reconnectAttempts = 0
    this._boardBlobId = null // id of our own last board deposit (for heartbeat replace)
    this._heartbeatTimer = null
  }

  /** This peer's rendezvous address (Ed25519 public key, base64url). */
  get key() { return this._self.key }

  /** The shared session room's rendezvous address. */
  get roomKey() { return this._room.key }

  /** The rendezvous address learned for a peerId, or null. */
  rdvKeyFor(peerId) { return this._peerRdvKey.get(peerId) ?? null }

  // ── lifecycle ────────────────────────────────────────────────────────────────

  /**
   * Announce presence, deposit our join onto the session board, and start the
   * discovery + inbox long-poll loops. Mirrors SignalingClient.connect() (fire and
   * forget from FabricClient.join()); dispatches 'signaling-open' once established.
   */
  async connect() {
    this._stopped = false
    try {
      await this._announceAndJoin()
      this._markOpen()
      if (this._pollLoop) {
        this._loopBoard()
        this._loopInbox()
        this._heartbeatTimer = setInterval(() => {
          this._announceAndJoin().catch(() => { /* retried next tick */ })
        }, HEARTBEAT_MS)
      }
    } catch (err) {
      this._scheduleReconnect()
    }
  }

  /** Announce our presence + (re)deposit our signed join onto the room board. */
  async _announceAndJoin() {
    // Announce our own presence so a peer can also resolve us directly. Endpoints
    // are opaque hints; we advertise none (the WebRTC/ICE path handles reachability).
    await this._self.announce({ meta: 'vulos-fabric', ttl: 0 }).catch(() => {})
    // Deposit our signed join (identical payload to the WS broadcast) onto the
    // board, wrapped with our peerId + rendezvous address so peers can route to us.
    const join = await this._core._buildJoinPayload()
    const bytes = this._wrap(join)
    // Replace our previous heartbeat so the board stays ~one live blob per member.
    if (this._boardBlobId) {
      this._room.signalAck([this._boardBlobId]).catch(() => {})
    }
    const res = await this._self.signalDeposit(this._room.key, bytes)
    this._boardBlobId = res && res.id ? res.id : null
  }

  /** Cleanly leave: tombstone on the board, withdraw presence, stop loops. */
  close() {
    this._stopped = true
    clearInterval(this._heartbeatTimer)
    this._heartbeatTimer = null
    // Best-effort leave tombstone so peers drop us promptly, then withdraw.
    const leave = { type: 'leave', session: this._session }
    this._self.signalDeposit(this._room.key, this._wrap(leave)).catch(() => {})
    if (this._boardBlobId) this._room.signalAck([this._boardBlobId]).catch(() => {})
    this._self.withdraw().catch(() => {})
  }

  /**
   * Send a signal (offer/answer/ice) to a peer over its rendezvous inbox. Same
   * signature as SignalingClient.signal(); the payload is built + ECDSA-signed by
   * the shared core, then deposited as opaque bytes to the recipient's rendezvous
   * key. Silently drops if we have not learned the recipient's rendezvous address
   * yet (FabricClient only signals peers it discovered via the board).
   */
  async signal(type, toId, data = {}) {
    const rdvKey = this._peerRdvKey.get(toId)
    if (!rdvKey) return
    const payload = await this._core._buildSignalPayload(type, toId, data)
    await this._self.signalDeposit(rdvKey, this._wrap(payload)).catch((err) => {
      // A deposit failure only delays this frame; ICE is best-effort and
      // offer/answer are re-driven on reconnect. Never throw into FabricClient.
      if (typeof console !== 'undefined') console.warn('[rendezvous-signal] deposit failed:', err?.message)
    })
  }

  // ── peer-key helpers (delegated to the shared core, unchanged semantics) ──────

  hasPeerKey(id) { return this._core.hasPeerKey(id) }
  getPeerBoxKey(id) { return this._core.getPeerBoxKey(id) }
  getPeerSignedPreKey(id) { return this._core.getPeerSignedPreKey(id) }
  isPeerV2Capable(id) { return this._core.isPeerV2Capable(id) }
  verifyPeerSignedPreKey(id, spk) { return this._core.verifyPeerSignedPreKey(id, spk) }
  verifyPeerSig(id, msg, sig) { return this._core.verifyPeerSig(id, msg, sig) }

  // ── internals ─────────────────────────────────────────────────────────────────

  /** Wrap a SignalPayload with our routing identity → opaque bytes for a deposit. */
  _wrap(payload) {
    return utf8.encode(JSON.stringify({ from: this._peerId, rdvKey: this._self.key, payload }))
  }

  /** Parse a deposited blob's opaque bytes back into { from, rdvKey, payload }. */
  _unwrap(bytes) {
    try {
      const obj = JSON.parse(utf8dec.decode(bytes))
      if (!obj || typeof obj !== 'object' || !obj.from || !obj.payload) return null
      return obj
    } catch { return null }
  }

  _markOpen() {
    this._reconnectAttempts = 0
    this._degraded = false
    if (!this._open) {
      this._open = true
      this.dispatchEvent(new CustomEvent('signaling-open'))
    }
  }

  _markClosed() {
    if (this._open) {
      this._open = false
      this.dispatchEvent(new CustomEvent('signaling-close'))
    }
  }

  _scheduleReconnect() {
    if (this._stopped) return
    this._markClosed()
    this._reconnectAttempts++
    if (this._reconnectAttempts >= this._maxAttempts && !this._degraded) {
      this._degraded = true
      this.dispatchEvent(new CustomEvent('offline', { detail: { attempts: this._reconnectAttempts } }))
    }
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this._reconnectAttempts - 1), RECONNECT_MAX_MS)
    setTimeout(() => { if (!this._stopped) this.connect() }, delay)
  }

  /** One board poll → discover joins/leaves. Returns the number of blobs seen. */
  async _pollBoardOnce(wait = 0) {
    const blobs = await this._room.signalPoll({ wait })
    for (const b of blobs) {
      if (this._seenBoard.has(b.id)) continue
      this._rememberBoardBlob(b.id)
      const w = this._unwrap(b.payload)
      if (!w || w.from === this._peerId) continue // skip malformed / self
      if (w.rdvKey) this._peerRdvKey.set(w.from, w.rdvKey)
      const p = w.payload
      if (p && p.type === 'leave') {
        if (this._knownPeers.delete(w.from)) {
          await this._core._processSignal(w.from, p) // → FabricClient closes the peer
        }
        continue
      }
      // A join (or any first sighting): process ONCE per peer. Re-processing a
      // join for a peer mid-negotiation would reset its RTCPeerConnection, so
      // heartbeats only refresh the routing hint above, never re-dispatch.
      if (!this._knownPeers.has(w.from)) {
        this._knownPeers.add(w.from)
        await this._core._processSignal(w.from, p)
      }
    }
    return blobs.length
  }

  /** One inbox poll → deliver offer/answer/ice addressed to us, then ack them. */
  async _pollInboxOnce(wait = 0) {
    const blobs = await this._self.signalPoll({ wait })
    const ackIds = []
    for (const b of blobs) {
      ackIds.push(b.id)
      const w = this._unwrap(b.payload)
      if (!w || w.from === this._peerId) continue
      if (w.rdvKey) this._peerRdvKey.set(w.from, w.rdvKey)
      await this._core._processSignal(w.from, w.payload)
    }
    if (ackIds.length) await this._self.signalAck(ackIds).catch(() => {})
    return blobs.length
  }

  _rememberBoardBlob(id) {
    if (this._seenBoard.size >= SEEN_BOARD_MAX) {
      this._seenBoard.delete(this._seenBoard.values().next().value)
    }
    this._seenBoard.add(id)
  }

  async _loopBoard() {
    while (!this._stopped) {
      try {
        await this._pollBoardOnce(POLL_WAIT_S)
        this._markOpen()
      } catch {
        this._scheduleReconnect()
        return
      }
      if (!this._stopped) await sleep(POLL_GAP_MS)
    }
  }

  async _loopInbox() {
    while (!this._stopped) {
      try {
        await this._pollInboxOnce(POLL_WAIT_S)
      } catch {
        // Inbox errors are transient; the board loop owns reconnect signaling.
        if (!this._stopped) await sleep(POLL_GAP_MS)
        continue
      }
      if (!this._stopped) await sleep(POLL_GAP_MS)
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
