// no-broker-dep:allow-file: names vulos-relayd once, describing the OPTIONAL
// rendezvousBaseUrl/relayBaseUrl parameters, both defaulted to '' below — "the existing
// /api/peering/* path is untouched when this option is absent". No default endpoint.
/**
 * fabric.js — Diwan fabric client adapter (OFFICE-20).
 *
 * Joins a Vulos fabric session for a given document/session id:
 *  1. Fetches ICE/TURN credentials from the OS relay  (/api/peering/ice  or
 *     the cloud /api/turn/credentials as fallback).
 *  2. Opens a SignalingClient to the OS peering WebSocket stream.
 *  3. Negotiates a WebRTC RTCPeerConnection per remote peer (offer/answer/ICE
 *     via the "signal" channel).
 *  4. Opens an RTCDataChannel for duplex application messages.
 *  5. Falls back to a relay circuit (via the relay deposit/pickup HTTP
 *     API) when the data channel cannot be established within RELAY_TIMEOUT_MS.
 *
 * Usage:
 *   const fc = new FabricClient({ sessionId, peerId, signalingUrl, iceUrl })
 *   fc.addEventListener('message', ({ detail: { from, data } }) => …)
 *   fc.addEventListener('state',   ({ detail: { peerId, state } }) => …)
 *   await fc.join()
 *   fc.send(data)           // broadcast to all connected peers
 *   fc.sendTo(peerId, data) // unicast
 *   fc.leave()
 *
 * State values: 'connecting' | 'connected' | 'relay' | 'disconnected'
 *
 * Pure JS/JSX — no CGO, no native deps.
 */

import { SignalingClient } from './signaling.js'
import { fetchIce, resolveStunFallback } from './call/ice.js'
import {
  generateBoxKeyPair, sealRelayBlob, openRelayBlob,
  bytesToB64, b64ToBytes,
  relayBlobVersion, sealRelayBlobV2, parseRelayBlobV2, openRelayBlobV2,
} from './relayBox.js'
import { PreKeyStore, x3dhInitiate, x3dhRespond } from './prekeys.js'
import { tokenTransportSecure } from './secureTransport.js'
import { RelayDepositError } from './errors.js'
import { RendezvousClient, RendezvousIdentity } from './rendezvous.js'
import { RendezvousSignalingClient } from './rendezvousSignaling.js'

/**
 * Byte-length of a relay payload datum.  Used by the billing meter to count
 * application-payload bytes without HTTP framing or base64 expansion.
 *
 * @param {string|ArrayBuffer|ArrayBufferView|any} data
 * @returns {number}
 */
function _byteSize(data) {
  if (data == null) return 0
  if (data instanceof ArrayBuffer) return data.byteLength
  if (ArrayBuffer.isView(data)) return data.byteLength
  const s = typeof data === 'string' ? data : JSON.stringify(data)
  try {
    return new TextEncoder().encode(s).byteLength
  } catch {
    return s.length   // safe fallback when TextEncoder unavailable
  }
}

const DATA_CHANNEL_LABEL = 'diwan-fabric'
const RELAY_TIMEOUT_MS = 8_000        // give P2P this long before falling back
const RELAY_POLL_MS = 2_000           // relay pickup polling interval
const RELAY_TTL_HOURS = 1
// Size of the one-time-prekey pool published per session (forward secrecy).
const ONE_TIME_PREKEY_POOL = 16

// ── DoS / resource caps ───────────────────────────────────────────────────────
const MAX_PENDING_CANDIDATES = 50     // per-peer ICE candidate queue (MED-DoS)
const MAX_PEERS = 50                  // per-session peer map (MED-DoS)
const MAX_PAYLOAD_BYTES = 256 * 1024  // data-channel + relay blob cap, 256 KB (MED-DoS)
// Relay-blob AEAD envelope overhead: version(1) + XChaCha nonce(24) + Poly1305 tag(16).
const RELAY_ENVELOPE_OVERHEAD = 1 + 24 + 16
// Upper bound on the base64 length of an encrypted relay blob carrying a
// max-size (MAX_PAYLOAD_BYTES) plaintext, so we can reject abusive blobs before
// spending any crypto on them.  base64 expands ~4/3; +4 for padding slack.
const MAX_RELAY_BLOB_B64 =
  Math.ceil((MAX_PAYLOAD_BYTES + RELAY_ENVELOPE_OVERHEAD) / 3) * 4 + 4

export class FabricClient extends EventTarget {
  /**
   * @param {object} opts
   * @param {string}   opts.sessionId      - document / room id
   * @param {string}   opts.peerId         - this peer's identity
   * @param {string}   opts.signalingUrl   - ws[s]://host/api/peering/stream
   * @param {string}  [opts.iceUrl]        - GET URL returning { ice_servers: [...] }
   *                                         defaults to /api/peering/ice
   * @param {string}  [opts.relayBaseUrl]  - base URL for relay deposit/pickup
   *                                         defaults to '' (same origin)
   * @param {string}  [opts.authToken]     - Bearer JWT (optional)
   * @param {boolean} [opts.allowUnsignedRelayAuth]
   *        - opt in to the unsigned "Vula-Relay <peerId>.<ts>" fallback auth
   *          header when no authToken is configured. This header is forgeable
   *          (anyone can claim any peerId), so it is OFF by default; without it
   *          and without a JWT, the relay request is sent with no Authorization
   *          header and the server's accept policy decides.
   * @param {boolean} [opts.requirePeerAuth=true]
   *        - when true (default), offer/answer/ice frames from peers with no
   *          stored public key are dropped — only keyed (signed) peers can
   *          establish WebRTC connections. Set to false to revert to TOFU-only
   *          behaviour and accept unsigned frames from unknown peers (needed
   *          when interoperating with pre-auth SDK versions).
   */
  constructor({
    sessionId,
    peerId,
    signalingUrl,
    iceUrl = '/api/peering/ice',
    relayBaseUrl = '',
    authToken = null,
    allowUnsignedRelayAuth = false,
    requirePeerAuth = true,
    // ── OPEN RENDEZVOUS transport (optional) ─────────────────────────────────
    // When set, this points the fabric at ANY vulos-relayd's open
    // announce/resolve/signal/mailbox + ICE surface, as an alternative to the
    // host box's /api/peering/* backend. Providing it ONLY changes defaults that
    // were not explicitly overridden (ICE is derived from the relay), and exposes
    // a ready RendezvousClient at .rendezvous — the existing /api/peering/* path
    // is untouched when this option is absent.
    rendezvousBaseUrl = '',
    // Ed25519 identity for rendezvous writes. A RendezvousIdentity, or a 32-byte
    // secret key (Uint8Array), or omitted to auto-generate an ephemeral one.
    rendezvousIdentity = null,
    // Mount prefix on the relay (default "/rendezvous").
    rendezvousPrefix = '/rendezvous',
  }) {
    super()

    // Rendezvous mode: derive the ICE URL from the relay unless the caller set an
    // explicit iceUrl, and build the RendezvousClient. This runs BEFORE the token
    // transport guard below so a rendezvous-derived ICE URL is validated too.
    this._rendezvous = null
    if (rendezvousBaseUrl) {
      let ident = rendezvousIdentity
      if (!(ident instanceof RendezvousIdentity)) {
        ident = ident ? new RendezvousIdentity(ident) : RendezvousIdentity.generate()
      }
      this._rendezvous = new RendezvousClient({
        baseUrl: rendezvousBaseUrl,
        identity: ident,
        prefix: rendezvousPrefix,
        authToken,
      })
      // Only override ICE when the caller left it at the /api/peering default.
      if (iceUrl === '/api/peering/ice') {
        iceUrl = this._rendezvous.iceUrl()
      }
    }

    // ── Credential-transport guard (security: plaintext token leak) ──────────
    // When an authToken is configured it is attached as `Authorization: Bearer`
    // to the ICE, relay deposit/pickup/ack and prekey fetches. Any of those
    // going to a plaintext http:// remote would leak the JWT. Refuse to
    // construct a client whose ICE or relay base URL would carry the token in
    // the clear (fail closed): https:// is required; http:// is permitted only
    // to a loopback host for local dev. Same-origin ('') / relative URLs inherit
    // the page origin and are always allowed. (The signaling URL is validated
    // separately by SignalingClient below.)
    if (authToken) {
      if (!tokenTransportSecure(relayBaseUrl)) {
        throw new RelayDepositError(
          'refusing to attach the auth token to an insecure relay base URL: ' +
          'https:// is required (http:// is permitted only to a loopback host for local dev)',
          { code: 'INSECURE_TOKEN_TRANSPORT' },
        )
      }
      if (!tokenTransportSecure(iceUrl)) {
        throw new RelayDepositError(
          'refusing to attach the auth token to an insecure ICE URL: ' +
          'https:// is required (http:// is permitted only to a loopback host for local dev)',
          { code: 'INSECURE_TOKEN_TRANSPORT' },
        )
      }
    }

    this._session = sessionId
    this._peerId = peerId
    this._iceUrl = iceUrl
    this._relayBase = relayBaseUrl
    this._authToken = authToken
    this._allowUnsignedRelayAuth = allowUnsignedRelayAuth
    this._requirePeerAuth = requirePeerAuth

    /** @type {Map<string, PeerState>} */
    this._peers = new Map()
    this._iceServers = []
    this._relayPollTimer = null
    this._stopped = false
    /** @type {CryptoKeyPair|null} — lazily generated on first deposit */
    this._depositKeyPair = null
    /** @type {string|null} — base64 raw public key for signaling announce */
    this._depositPubKeyB64 = null
    /**
     * Per-session X25519 box keypair used to encrypt relay-fallback payloads
     * end-to-end (XChaCha20-Poly1305 keyed by X25519-ECDH).  Separate from the
     * ECDSA deposit/signing identity above — WebCrypto/NaCl will not reuse a
     * sign/verify key for ECDH.  The public key is announced in the signaling
     * "join" frame so peers can seal payloads the relay server cannot read.
     * @type {{ privateKey: Uint8Array, publicKey: Uint8Array, publicKeyB64: string }|null}
     */
    this._boxKeyPair = null
    /** @type {string|null} — base64 raw X25519 box public key */
    this._boxPubKeyB64 = null

    /**
     * Per-session X3DH prekey store: a signed prekey (signed by the ECDSA
     * identity) plus a pool of one-time prekeys.  Used to derive FORWARD-SECRET
     * per-message content keys on the relay-fallback path (v2), replacing the
     * static-static ECDH of v1.  Lazily created in _ensurePreKeys().
     * @type {PreKeyStore|null}
     */
    this._preKeys = null
    /** @type {{id,pub,sig}|null} — our signed prekey public, announced via join */
    this._signedPreKeyPublic = null

    // ── Billing G-1: authoritative relay byte meter ───────────────────────────
    // Counts payload bytes transported via the relay fallback path.  These are
    // the bytes of the application `data` argument (not HTTP framing or base64
    // overhead).  The host backend reads these via relayByteCount / emits them
    // to CP as usage.  See docs/RELAY_BYTE_METER.md for the full contract.
    /** @type {number} bytes deposited (sent) via relay in this session */
    this._relayedBytesOut = 0
    /** @type {number} bytes picked up (received) via relay in this session */
    this._relayedBytesIn = 0

    // Shared callbacks — identical for both transports so the signed join/signal
    // payloads (and thus the E2E peer-auth handshake) are produced the same way
    // whether frames ride the host box's WebSocket or a relay's rendezvous inbox.
    const signalingCallbacks = {
      sessionId,
      peerId,
      // Publish the deposit signing public key in the join frame so the relay
      // server can bind it to our authenticated peerId and verify deposit sigs.
      getDepositPubKey: () => this._depositPubKeyB64,
      // Publish the X25519 box (encryption) public key in the join frame so
      // peers can seal relay-fallback payloads to us end-to-end.
      getBoxPubKey: () => this._boxPubKeyB64,
      // Publish the X3DH signed prekey {id,pub,sig} so peers can establish a
      // FORWARD-SECRET (v2) relay session.  The pub is signed by our ECDSA
      // identity; peers verify it before use (prekeys.go VerifySignedPreKey).
      getSignedPreKey: () => this._signedPreKeyPublic,
      // ── E2E peer authentication (security audit MEDIUM) ────────────────────
      // Wire the per-session ECDSA signing key into the signaling layer so that
      // all outgoing offer/answer/ice frames are signed.  The canonical signing
      // message includes `from` (binding sender identity) and, for offer/answer,
      // the full SDP (pinning the DTLS fingerprint).  Receivers verify using the
      // sender's pubkey from the prior 'join' frame or the embedded pubKey field.
      signFrame: (msg) => this._signDeposit(msg),
      // Surface the caller-supplied requirePeerAuth (default true).  When true,
      // offer/answer/ice frames from peers with no stored public key are dropped
      // outright — no TOFU fallback for unkeyed peers.  Frames from peers whose
      // key IS stored are always verified regardless of this flag.
      requirePeerAuth: this._requirePeerAuth,
    }

    // Transport selection: when a rendezvous relay is configured, run the whole
    // signaling lifecycle (presence discovery + offer/answer/ICE) over its OPEN
    // announce/resolve/signal surface with no host box. Otherwise use the host
    // box's /api/peering/* WebSocket exactly as before (default, unchanged path).
    if (this._rendezvous) {
      this._signaling = new RendezvousSignalingClient({
        selfClient: this._rendezvous,
        ...signalingCallbacks,
      })
    } else {
      this._signaling = new SignalingClient({
        signalingUrl,
        authToken,
        ...signalingCallbacks,
      })
    }
    this._signaling.addEventListener('signal', (ev) => this._onSignal(ev.detail))
    this._signaling.addEventListener('signaling-open', () => {
      // Re-offer to any existing peers after a reconnect.
      for (const [id, ps] of this._peers) {
        if (ps.state === 'disconnected') this._initiatePeer(id)
      }
    })
    this._signaling.addEventListener('signaling-close', () => {
      // Signaling dropped — data channels may still be alive.
    })
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /** Connect to the fabric session.  Resolves once signaling is up. */
  async join() {
    this._iceServers = await this._fetchICE()
    // Generate the deposit signing key up front so its public key is available
    // for the signaling "join" frame (the server binds it to our peerId).
    await this._ensureDepositKey()
    // Generate + sign the X3DH prekey bundle so its signed prekey can be
    // announced in the same "join" frame (forward-secret v2 relay path).
    await this._ensurePreKeys()
    // Publish the one-time-prekey pool so peers can CLAIM a per-sender OPK for
    // full forward secrecy (best-effort; v2 still works signed-prekey-only).
    this._publishPreKeys().catch(() => { /* server may not host the endpoint */ })
    this._signaling.connect()
  }

  /** Broadcast a message to all connected peers. */
  send(data) {
    for (const ps of this._peers.values()) {
      this._sendToPeer(ps, data)
    }
  }

  /** Send a message to one specific peer. */
  sendTo(peerId, data) {
    const ps = this._peers.get(peerId)
    if (ps) this._sendToPeer(ps, data)
  }

  /** Disconnect from all peers and the signaling channel. */
  leave() {
    this._stopped = true
    clearInterval(this._relayPollTimer)
    for (const ps of this._peers.values()) {
      clearTimeout(ps.reinitTimer)
      ps.dc?.close()
      ps.pc?.close()
    }
    this._peers.clear()
    this._signaling.close()
  }

  /** Read-only snapshot of current peer states. */
  get peerStates() {
    const out = {}
    for (const [id, ps] of this._peers) out[id] = ps.state
    return out
  }

  /**
   * The RendezvousClient bound to this fabric when constructed with a
   * `rendezvousBaseUrl`, else null. Use it for open announce/resolve/signal/
   * mailbox against the relay (see rendezvous.js). Its `.key` is this peer's
   * Ed25519 rendezvous address.
   * @type {RendezvousClient|null}
   */
  get rendezvous() {
    return this._rendezvous
  }

  // ── Billing G-1: relay byte meter ─────────────────────────────────────────

  /**
   * Authoritative relay byte count for this session.
   *
   * Contract (see docs/RELAY_BYTE_METER.md):
   *   • `out` — total application-payload bytes deposited to the relay server.
   *   • `in`  — total application-payload bytes picked up from the relay server.
   *   • `total` — `out + in` (useful for cap enforcement / billing period quota).
   *
   * "Payload bytes" means the byte length of the `data` argument to send() /
   * sendTo() that was routed through the relay; HTTP framing and base64
   * expansion are NOT counted.  This is the number CP should debit against the
   * session's relay allowance.
   *
   * The host backend should read this counter at the end of a session (or on a
   * periodic flush) and emit it to CP via the usage-report endpoint.
   *
   * @returns {{ out: number, in: number, total: number }}
   */
  get relayByteCount() {
    return {
      out: this._relayedBytesOut,
      in:  this._relayedBytesIn,
      total: this._relayedBytesOut + this._relayedBytesIn,
    }
  }

  /**
   * Reset the relay byte counters to zero.
   * Call at the start of each billing period / usage-report flush window so
   * the host backend can report incremental usage rather than cumulative totals.
   */
  resetRelayByteCount() {
    this._relayedBytesOut = 0
    this._relayedBytesIn = 0
  }

  // ─── ICE / TURN ────────────────────────────────────────────────────────────

  async _fetchICE() {
    const headers = this._authToken ? { Authorization: `Bearer ${this._authToken}` } : {}
    return fetchIce(this._iceUrl, {
      responseKey: 'ice_servers',
      fetchOptions: { headers },
      fallbackIceServers: resolveStunFallback(),
    })
  }

  // ─── Peer management ───────────────────────────────────────────────────────

  _getOrCreatePeer(remoteId) {
    if (this._peers.has(remoteId)) return this._peers.get(remoteId)
    if (this._peers.size >= MAX_PEERS) {
      console.warn('[fabric] peer limit reached, dropping peer', remoteId)
      return null
    }
    const ps = new PeerState(remoteId)
    this._peers.set(remoteId, ps)
    return ps
  }

  /** Initiate an offer to a remote peer (called when we see their 'join'). */
  async _initiatePeer(remoteId) {
    const ps = this._getOrCreatePeer(remoteId)
    if (!ps) return                       // peer limit reached
    if (ps.state === 'connected') return
    ps.reset()

    const pc = this._buildPC(remoteId, ps)
    ps.pc = pc

    // Polite peer: lexicographically smaller peerId defers (impolite = offerer).
    const impolite = this._peerId < remoteId
    if (!impolite) return  // wait for the other side to offer

    const dc = pc.createDataChannel(DATA_CHANNEL_LABEL)
    ps.dc = dc
    this._wireDataChannel(dc, remoteId, ps)

    try {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      this._setRelayTimer(remoteId, ps)
      // Include pubKey so the recipient can verify even before our 'join'
      // was processed (handles out-of-order delivery).  The SDP embeds the
      // DTLS fingerprint; signing the full payload pins it end-to-end.
      await this._signaling.signal('offer', remoteId, {
        sdp: pc.localDescription.sdp,
        pubKey: this._depositPubKeyB64,
      })
      this._setPeerState(remoteId, ps, 'connecting')
    } catch (err) {
      console.error('[fabric] offer error:', err)
    }
  }

  _buildPC(remoteId, ps) {
    const pc = new RTCPeerConnection({ iceServers: this._iceServers })

    pc.addEventListener('icecandidate', ({ candidate }) => {
      if (candidate) {
        // signal() is async (signs the frame); fire-and-forget from this sync
        // event handler.  ICE candidates are best-effort — a dropped candidate
        // only delays connectivity, it does not break the session.
        this._signaling.signal('ice', remoteId, { candidate: candidate.toJSON() })
          .catch(err => console.warn('[fabric] ICE signal error:', err))
      }
    })

    pc.addEventListener('connectionstatechange', () => {
      const s = pc.connectionState
      if (s === 'connected') {
        clearTimeout(ps.relayTimer)
        this._setPeerState(remoteId, ps, 'connected')
      } else if (s === 'failed' || s === 'closed') {
        clearTimeout(ps.relayTimer)
        if (!this._stopped && ps.state !== 'relay') {
          this._activateRelay(remoteId, ps)
        }
      }
    })

    pc.addEventListener('datachannel', ({ channel }) => {
      ps.dc = channel
      this._wireDataChannel(channel, remoteId, ps)
    })

    return pc
  }

  _wireDataChannel(dc, remoteId, ps) {
    dc.binaryType = 'arraybuffer'

    dc.addEventListener('open', () => {
      clearTimeout(ps.relayTimer)
      clearTimeout(ps.reinitTimer)
      ps.reinitDelay = 0
      this._setPeerState(remoteId, ps, 'connected')
    })

    dc.addEventListener('message', ({ data }) => {
      if (_byteSize(data) > MAX_PAYLOAD_BYTES) {
        console.warn('[fabric] oversized data-channel payload from', remoteId, '— dropped')
        return
      }
      this.dispatchEvent(new CustomEvent('message', { detail: { from: remoteId, data } }))
    })

    dc.addEventListener('close', () => {
      if (!this._stopped) {
        this._setPeerState(remoteId, ps, 'disconnected')
        this._scheduleReinitiate(remoteId, ps)
      }
    })

    dc.addEventListener('error', (ev) => {
      console.warn('[fabric] data channel error:', ev)
    })
  }

  // ─── Signaling handler ─────────────────────────────────────────────────────

  async _onSignal({ from, payload }) {
    const { type, sdp, candidate } = payload
    if (from === this._peerId) return   // ignore self-echoes

    if (type === 'join') {
      await this._initiatePeer(from)
      return
    }

    if (type === 'leave') {
      const ps = this._peers.get(from)
      if (ps) {
        ps.left = true              // explicit departure — stop reconnect attempts
        clearTimeout(ps.reinitTimer)
        ps.dc?.close()
        ps.pc?.close()
        this._setPeerState(from, ps, 'disconnected')
      }
      return
    }

    const ps = this._getOrCreatePeer(from)
    if (!ps) return                       // peer limit reached

    if (type === 'offer') {
      // GLARE GUARD.
      //
      // Over the rendezvous transport BOTH peers see each other's `join` on the
      // shared presence board, so both call _initiatePeer() and both send an
      // offer. Without a tie-break each side then reset()s its own connection to
      // answer the other's offer, both offers are abandoned, and the negotiation
      // deadlocks until the 8s relay timer fires — observed failing ~1 run in 3
      // in the real-transport E2E.
      //
      // Standard perfect-negotiation resolution: exactly one side is "polite",
      // decided by a comparison both sides compute identically and oppositely.
      // The IMPOLITE side ignores an offer that collides with its own in-flight
      // offer (its own negotiation survives); the polite side rolls back and
      // answers. When there is no collision this changes nothing, so the
      // host-box WebSocket path — where only one side ever initiates — behaves
      // exactly as before.
      const polite = this._peerId > from
      if (!polite && ps.pc && ps.pc.signalingState === 'have-local-offer') {
        return
      }
      ps.reset()
      const pc = this._buildPC(from, ps)
      ps.pc = pc
      try {
        await pc.setRemoteDescription({ type: 'offer', sdp })
        // Apply any queued candidates.
        for (const c of ps.pendingCandidates) await pc.addIceCandidate(c)
        ps.pendingCandidates = []
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        this._setRelayTimer(from, ps)
        // Include pubKey in answer for the same reason as in the offer: allows
        // the offerer to verify even if they missed our 'join'.  The signed SDP
        // also pins the answerer's DTLS fingerprint against MITM swap.
        await this._signaling.signal('answer', from, {
          sdp: pc.localDescription.sdp,
          pubKey: this._depositPubKeyB64,
        })
        this._setPeerState(from, ps, 'connecting')
      } catch (err) {
        console.error('[fabric] answer error:', err)
      }
    } else if (type === 'answer') {
      if (!ps.pc) return
      try {
        await ps.pc.setRemoteDescription({ type: 'answer', sdp })
        for (const c of ps.pendingCandidates) await ps.pc.addIceCandidate(c)
        ps.pendingCandidates = []
      } catch (err) {
        console.error('[fabric] setRemoteDescription answer error:', err)
      }
    } else if (type === 'ice') {
      if (!candidate) return
      if (ps.pc && ps.pc.remoteDescription) {
        try { await ps.pc.addIceCandidate(candidate) } catch { /* ignore stale */ }
      } else if (ps.pendingCandidates.length < MAX_PENDING_CANDIDATES) {
        ps.pendingCandidates.push(candidate)
      }
      // else: silently drop — candidates beyond the cap are best-effort anyway
    }
  }

  // ─── Relay fallback ────────────────────────────────────────────────────────

  _setRelayTimer(remoteId, ps) {
    clearTimeout(ps.relayTimer)
    // GLARE/FALLBACK SYMMETRY.
    // Start listening on the relay circuit as soon as a negotiation is in
    // flight, not only once WE give up on it. The peer may give up before we do
    // (its timer, its NAT), and it then deposits into OUR mailbox — which we
    // would never read while we still believed we were merely 'connecting'.
    // That made the documented content-blind fallback one-directional and, in
    // practice, dead. Polling stops itself once no peer needs it (_relayPoll).
    this._startRelayPolling()
    ps.relayTimer = setTimeout(() => {
      if (ps.state !== 'connected') {
        this._activateRelay(remoteId, ps)
      }
    }, RELAY_TIMEOUT_MS)
  }

  /**
   * Keep trying to rebuild a dropped peer connection.
   *
   * The previous behaviour was ONE retry, 2s after the data channel closed. Over
   * the rendezvous transport that single attempt is often spent while the
   * network is still down (a sleeping laptop, a dropped link), and nothing ever
   * tries again: the peer's `join` is dispatched only once per peer from the
   * presence board, so the signaling layer will not re-trigger negotiation
   * either. The session then stayed dead until a page reload.
   *
   * Retries with exponential back-off (2s → 16s), stops on success, on an
   * explicit peer `leave`, and when the client is torn down.
   */
  _scheduleReinitiate(remoteId, ps) {
    if (this._stopped || ps.left) return
    clearTimeout(ps.reinitTimer)
    ps.reinitDelay = ps.reinitDelay ? Math.min(ps.reinitDelay * 2, 16_000) : 2_000
    ps.reinitTimer = setTimeout(() => {
      if (this._stopped || ps.left) return
      if (ps.state === 'connected') { ps.reinitDelay = 0; return }
      this._initiatePeer(remoteId).catch(() => { /* next attempt covers it */ })
      this._scheduleReinitiate(remoteId, ps)
    }, ps.reinitDelay)
  }

  _activateRelay(remoteId, ps) {
    if (ps.state === 'relay') return
    console.info(`[fabric] P2P failed for ${remoteId}; switching to relay circuit`)
    this._setPeerState(remoteId, ps, 'relay')
    this._startRelayPolling()
  }

  /** Start polling the relay pickup endpoint for any peers in relay mode. */
  _startRelayPolling() {
    if (this._relayPollTimer) return
    this._relayPollTimer = setInterval(() => this._relayPoll(), RELAY_POLL_MS)
  }

  async _relayPoll() {
    // 'connecting' counts (see _setRelayTimer): a peer that has already fallen
    // back is depositing for us while we are still negotiating. Once every peer
    // is either connected or gone, this clears itself.
    const relayPeers = [...this._peers.entries()]
      .filter(([, ps]) => ps.state === 'relay' || ps.state === 'connecting')
    if (relayPeers.length === 0) {
      clearInterval(this._relayPollTimer)
      this._relayPollTimer = null
      return
    }
    try {
      const blobs = await this._relayFetch()
      if (!Array.isArray(blobs) || blobs.length === 0) return
      const ackIds = []
      for (const blob of blobs) {
        const id = await this._processRelayBlob(blob)
        if (id) ackIds.push(id)
      }
      if (ackIds.length) await this._relayAck(ackIds)
    } catch (err) {
      console.warn('[fabric] relay poll error:', err.message)
    }
  }

  /**
   * Authorization headers for the host-box relay fallback endpoints. Unused on
   * the rendezvous mailbox path (that transport is Ed25519-signature-authed).
   */
  _relayHeaders() {
    const headers = { 'Content-Type': 'application/json' }
    if (this._authToken) {
      // Bearer JWT takes precedence when present.
      headers['Authorization'] = `Bearer ${this._authToken}`
    } else if (this._allowUnsignedRelayAuth) {
      // Forgeable unsigned fallback: "Vula-Relay <peerId>.<ts>" (anyone can
      // claim any peerId). Only emitted when the caller has explicitly opted
      // in via allowUnsignedRelayAuth; relay accept policy decides the rest.
      headers['Authorization'] = `Vula-Relay ${this._peerId}.${Math.floor(Date.now() / 1000)}`
    }
    return headers
  }

  /**
   * Fetch pending relay-fallback blobs, normalised to the internal shape
   * { id, from, blob_b64, epk, sig, nonce } regardless of transport.
   *   • rendezvous mode → the peer's rendezvous MAILBOX (content-blind, OS-free);
   *     each mailbox blob's opaque payload is our JSON deposit envelope.
   *   • host-box mode   → GET /api/peering/relay/pickup (unchanged).
   */
  async _relayFetch() {
    if (this._rendezvous) {
      const mb = await this._rendezvous.mailboxPoll({ wait: 0 })
      return mb
        .map((b) => {
          const w = this._unwrapRelayEnvelope(b.payload)
          if (!w) return null
          // The rendezvous blob id is what we ack; carry it as the blob id.
          return { id: b.id, from: w.from, blob_b64: w.blob_b64, epk: w.epk, sig: w.sig, nonce: w.nonce }
        })
        .filter(Boolean)
    }
    const res = await fetch(`${this._relayBase}/api/peering/relay/pickup`, {
      method: 'GET',
      headers: this._relayHeaders(),
    })
    if (!res.ok) return []
    const { blobs } = await res.json()
    return Array.isArray(blobs) ? blobs : []
  }

  /** Ack consumed relay-fallback blobs on whichever transport is in use. */
  async _relayAck(ackIds) {
    if (this._rendezvous) {
      await this._rendezvous.mailboxAck(ackIds).catch(() => { /* best-effort */ })
      return
    }
    await fetch(`${this._relayBase}/api/peering/relay/ack`, {
      method: 'POST',
      headers: this._relayHeaders(),
      body: JSON.stringify({ blob_ids: ackIds }),
    }).catch(() => { /* best-effort */ })
  }

  /** Parse a rendezvous mailbox blob's opaque bytes back into our deposit envelope. */
  _unwrapRelayEnvelope(bytes) {
    try {
      const w = JSON.parse(new TextDecoder().decode(bytes))
      if (!w || typeof w !== 'object' || typeof w.blob_b64 !== 'string') return null
      return w
    } catch { return null }
  }

  /**
   * Verify + decrypt one relay-fallback blob and, on success, dispatch its
   * message and return the id to ack. Returns null to drop the blob (oversized,
   * missing epk, bad signature, undecryptable, wrong session). The crypto is
   * IDENTICAL on both transports — only the byte source differs.
   *
   * @param {{id,from,blob_b64,epk,sig,nonce}} blob
   * @returns {Promise<string|null>}
   */
  async _processRelayBlob(blob) {
    try {
      // ── MED-DoS: relay blob size cap ────────────────────────────────────
      // Cap the encoded ciphertext size up front (before any crypto work).
      // The exact plaintext cap is re-checked post-decrypt below.
      if (typeof blob.blob_b64 !== 'string' || blob.blob_b64.length > MAX_RELAY_BLOB_B64) {
        return null  // oversized / malformed → drop
      }

      // ── E2E confidentiality: the blob carries the sender's box pubkey ────
      // (epk).  Without it we cannot derive the shared secret, so the blob
      // is undecryptable — drop it (fail closed; no plaintext fallback).
      if (!blob.epk) return null

      // ── MED: verify relay-blob inbound signature ─────────────────────────
      // The depositor signs { to, from, nonce, blob_b64, epk } (see
      // _relayDeposit).  If we hold a key for the sender (imported via
      // signaling join / TOFU), the blob MUST carry a valid signature.
      // Unknown senders (no key held) are allowed through for backward
      // compat with pre-auth relay clients — confidentiality still holds
      // because decryption below depends only on the box keys.
      if (blob.sig && blob.nonce) {
        const sigMsg = JSON.stringify({
          to: this._peerId,
          from: blob.from,
          nonce: blob.nonce,
          blob_b64: blob.blob_b64,
          epk: blob.epk,
        })
        const result = await this._signaling.verifyPeerSig(blob.from, sigMsg, blob.sig)
        if (result === false) return null  // key held + sig invalid → tamper/impersonation
        // result === null: no key stored → allow through (backward compat)
      } else if (this._signaling.hasPeerKey(blob.from)) {
        // Sender published a key via signaling but blob is unsigned.
        // Reject: prevents server-injected blobs and pre-auth-era replays
        // from being accepted once the sender has upgraded to signed deposits.
        return null
      }

      // ── Decrypt end-to-end ──────────────────────────────────────────────
      // openRelayBlob* throws on tamper / wrong key (AEAD failure) or a
      // version/length mismatch → caught below and the blob is skipped.
      await this._ensurePreKeys()
      let plaintextBytes
      if (relayBlobVersion(blob.blob_b64) === 2) {
        // ── v2: X3DH forward-secret content key ──────────────────────────
        const parsed = parseRelayBlobV2(blob.blob_b64)
        const spkPriv = this._preKeys.signedPreKeyPriv(parsed.signedPreKeyId)
        if (!spkPriv) return null            // unknown signed prekey → fail closed
        let opkPriv = null
        if (parsed.oneTimePreKeyId) {
          opkPriv = this._preKeys.oneTimePreKeyPriv(parsed.oneTimePreKeyId)
          // Already-consumed / unknown one-time prekey: fail closed. This also
          // rejects replays of a one-time-prekey handshake (FS).
          if (!opkPriv) return null
        }
        const sk = x3dhRespond({
          identityPriv: this._boxKeyPair.privateKey,
          senderIdentityPub: b64ToBytes(blob.epk),
          signedPreKeyPriv: spkPriv,
          oneTimePreKeyPriv: opkPriv,
          ephemeralPub: parsed.ephemeralPub,
          senderId: blob.from,
          recipientId: this._peerId,
        })
        // Throws on tamper / wrong key BEFORE we burn the one-time prekey.
        plaintextBytes = openRelayBlobV2({
          parsed, key: sk, from: blob.from, to: this._peerId, session: this._session,
        })
        // FORWARD SECRECY: delete the consumed one-time prekey now so its
        // private scalar can never again derive this (or any) message key.
        if (parsed.oneTimePreKeyId) this._preKeys.consumeOneTimePreKey(parsed.oneTimePreKeyId)
      } else {
        // ── v1: legacy static-static ECDH (no forward secrecy) ───────────
        plaintextBytes = openRelayBlob({
          blobB64: blob.blob_b64,
          recipientBoxPriv: this._boxKeyPair.privateKey,
          senderBoxPubB64: blob.epk,
          from: blob.from,
          to: this._peerId,
          session: this._session,
        })
      }
      const rawPayload = new TextDecoder().decode(plaintextBytes)
      if (rawPayload.length > MAX_PAYLOAD_BYTES) return null  // oversized plaintext → drop
      const msg = JSON.parse(rawPayload)
      if (msg.session !== this._session) return null

      // ── billing meter: count inbound payload bytes ─────────────────────
      this._relayedBytesIn += _byteSize(msg.data)
      // A blob arriving from this peer proves the relay circuit works in at
      // least one direction and that the peer has given up on direct. Adopt it
      // for our own sends too, otherwise our replies keep being dropped against
      // a peer we still list as 'connecting' and the fallback stays half-open.
      const senderPs = this._peers.get(blob.from)
      if (senderPs && senderPs.state !== 'connected' && senderPs.state !== 'relay') {
        clearTimeout(senderPs.relayTimer)
        this._setPeerState(blob.from, senderPs, 'relay')
      }
      this.dispatchEvent(new CustomEvent('message', { detail: { from: blob.from, data: msg.data } }))
      return blob.id
    } catch { /* malformed / undecryptable blob, skip */ return null }
  }

  /**
   * Deposit a message via the relay for a specific peer.
   *
   * Integrity signature: the deposit payload (blob_b64 + nonce + to + from)
   * is signed with a per-session ECDSA P-256 key held in memory.  The relay
   * server SHOULD verify this signature using the public key exchanged during
   * the signaling join — see `depositPubKey` in the join payload (published by
   * signaling.js, bound server-side to the authenticated peerId).  If the
   * relay does not yet enforce signature verification it MUST at minimum check
   * that the `from` field matches the authenticated peerId (JWT sub or
   * Vula-Relay header).
   *
   * Trust model: unsigned deposits are rejected by a correctly-configured
   * relay server.  Signed-but-unverified (relay not updated) degrades to the
   * previous unsigned behaviour until the server enforces verification.
   *
   * Confidentiality (E2E): the application payload is SEALED with
   * XChaCha20-Poly1305 keyed by an X25519-ECDH shared secret between this peer's
   * box key and the recipient's announced box key, so the relay/host server only
   * ever sees ciphertext.  The ECDSA signature is layered over the ciphertext
   * (covering the sender's box pubkey `epk` too), so authenticity is unchanged.
   *
   * FAIL-CLOSED: if the recipient's box public key has not been learned yet
   * (no keyed 'join' seen), the deposit is SKIPPED rather than sent in the
   * clear — the sovereign/E2E guarantee must not silently degrade to plaintext.
   */
  async _relayDeposit(toPeerId, data) {
    // ── billing meter: count outbound payload bytes before encoding ──────────
    this._relayedBytesOut += _byteSize(data)
    try {
      await this._ensureDepositKey()

      // Recipient's X25519 box public key (announced in their signaling 'join').
      const recipientBoxPubB64 = this._signaling.getPeerBoxKey(toPeerId)
      if (!recipientBoxPubB64) {
        // Fail closed: no E2E key for this peer → do NOT leak plaintext to the relay.
        console.warn(
          `[fabric] relay deposit skipped for ${toPeerId}: no box key (cannot encrypt end-to-end)`,
        )
        return
      }

      // Plaintext is the same {session, data} envelope as before, now sealed.
      const plaintext = new TextEncoder().encode(
        JSON.stringify({ session: this._session, data }),
      )
      // Seal: prefer the forward-secret X3DH (v2) path; fall back to static-static
      // (v1) only when no signed prekey is available. Never plaintext.
      const blob_b64 = await this._sealForPeer(toPeerId, recipientBoxPubB64, plaintext)
      const nonce = crypto.randomUUID()
      const epk = this._boxPubKeyB64   // sender box pubkey, authenticated by sig below

      // Build the signing message: canonical JSON of the fields the server
      // can reconstruct independently (to, from, nonce, blob_b64, epk).
      // Including `epk` binds the sender's box key end-to-end so a relay cannot
      // swap it for one it controls.
      const signingMsg = JSON.stringify({
        to: toPeerId,
        from: this._peerId,
        nonce,
        blob_b64,
        epk,
      })

      // Sign with the session signing key (lazily generated ECDSA P-256).
      // The corresponding public key is published in the signaling join payload.
      const sigB64 = await this._signDeposit(signingMsg)

      const envelope = { to: toPeerId, from: this._peerId, blob_b64, nonce, sig: sigB64, epk }

      if (this._rendezvous) {
        // OS-free fallback: deposit the SAME signed+sealed envelope into the
        // recipient's content-blind rendezvous MAILBOX. The relay only moves
        // opaque bytes keyed by the peer's Ed25519 address; it cannot read or
        // forge the inner ECDSA-signed, XChaCha-sealed blob.
        const rk = this._signaling.rdvKeyFor(toPeerId)
        if (!rk) {
          console.warn(`[fabric] relay deposit skipped for ${toPeerId}: rendezvous address unknown`)
          return
        }
        const wrapped = new TextEncoder().encode(JSON.stringify(envelope))
        await this._rendezvous.mailboxDeposit(rk, wrapped, RELAY_TTL_HOURS * 3600)
        return
      }

      const headers = this._relayHeaders()
      await fetch(`${this._relayBase}/api/peering/relay/deposit`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...envelope, ttl_hours: RELAY_TTL_HOURS }),
      })
    } catch (err) {
      console.warn('[fabric] relay deposit error:', err.message)
    }
  }

  /**
   * Seal `plaintext` for `toPeerId`, choosing the strongest available content
   * crypto:
   *   • v2 (X3DH, FORWARD-SECRET) whenever a verified signed prekey is available
   *     — preferred. A per-sender one-time prekey is CLAIMED (Contract A) for
   *     full forward secrecy; absent one, signed-prekey-only v2 is used (still no
   *     static-identity dependence for content secrecy).
   *   • v1 (static-static ECDH, NO forward secrecy) only when no signed prekey
   *     can be obtained — preserves reachability to pre-FS peers.
   *
   * @param {string} toPeerId
   * @param {string} recipientBoxPubB64  recipient X25519 box (identity) pubkey
   * @param {Uint8Array} plaintext
   * @returns {Promise<string>} blob_b64
   */
  async _sealForPeer(toPeerId, recipientBoxPubB64, plaintext) {
    await this._ensurePreKeys()

    // A verified signed prekey announced via the peer's join frame (already
    // ECDSA-checked by signaling.js).
    let signedPreKey = this._signaling.getPeerSignedPreKey(toPeerId)
    let opk = null

    // Claim a per-sender one-time prekey for full forward secrecy (Contract A).
    const claim = await this._claimPreKeys(toPeerId)
    if (claim) {
      if (!signedPreKey && claim.signed_prekey &&
          await this._signaling.verifyPeerSignedPreKey(toPeerId, claim.signed_prekey)) {
        signedPreKey = claim.signed_prekey
      }
      const c = claim.one_time_prekey
      if (signedPreKey && c && typeof c.pub === 'string' && typeof c.id === 'string') {
        opk = c
      }
    }

    // ── ANTI-DOWNGRADE (forward secrecy) ─────────────────────────────────────
    // If the recipient has been PINNED as v2-capable (it presented a signed
    // `supportsV2` commitment or a verified signed prekey at some point) but we
    // now have NO signed prekey for it, the prekey was stripped/omitted by the
    // untrusted signaling/relay server.  Falling back to v1 static-static here
    // would silently drop forward secrecy — exactly the downgrade we must block.
    // FAIL CLOSED: abort the seal.  _relayDeposit catches this and skips the
    // deposit rather than sending a non-forward-secret blob to a v2 peer.
    // (Genuine legacy v1 peers are never pinned, so they still fall through to v1.)
    if (!signedPreKey && this._signaling.isPeerV2Capable(toPeerId)) {
      throw new Error(
        `relay seal aborted for ${toPeerId}: signed prekey missing for a v2-capable peer ` +
        `(forward-secrecy downgrade attack — refusing v1 static-static fallback)`,
      )
    }

    if (signedPreKey) {
      // ── v2: forward-secret X3DH ──────────────────────────────────────────
      const { ephemeralPub, sk } = x3dhInitiate({
        identityPriv: this._boxKeyPair.privateKey,
        recipientIdentityPub: b64ToBytes(recipientBoxPubB64),
        signedPreKeyPub: b64ToBytes(signedPreKey.pub),
        oneTimePreKeyPub: opk ? b64ToBytes(opk.pub) : null,
        senderId: this._peerId,
        recipientId: toPeerId,
      })
      return sealRelayBlobV2({
        plaintext,
        key: sk,
        ephemeralPub,
        signedPreKeyId: signedPreKey.id,
        oneTimePreKeyId: opk ? opk.id : null,
        from: this._peerId,
        to: toPeerId,
        session: this._session,
      })
    }

    // ── v1: static-static fallback (no forward secrecy, still encrypted) ────
    return sealRelayBlob({
      plaintext,
      senderBoxPriv: this._boxKeyPair.privateKey,
      recipientBoxPubB64,
      from: this._peerId,
      to: toPeerId,
      session: this._session,
    })
  }

  /**
   * Lazily generate (or reuse) a per-session ECDSA P-256 signing key and export
   * its raw public key as base64 into `_depositPubKeyB64`.
   *
   * Called eagerly from join() so the public key is available for the signaling
   * "join" announcement — the server binds it to the authenticated peerId and
   * uses it to verify deposit signatures.
   */
  async _ensureDepositKey() {
    // Generate the X25519 box keypair alongside the signing key so its public
    // key is announced in the same "join" frame.
    if (!this._boxKeyPair) {
      this._boxKeyPair = generateBoxKeyPair()
      this._boxPubKeyB64 = this._boxKeyPair.publicKeyB64
    }
    if (this._depositKeyPair) return
    // Non-extractable: the private signing key must never leave the crypto
    // subsystem. Per the WebCrypto spec, generateKey() always marks the public
    // key of an asymmetric pair as extractable regardless of this flag, so the
    // public key can still be exported below while the private key cannot.
    this._depositKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,      // private key non-extractable; public key stays exportable
      ['sign', 'verify'],
    )
    // Export the public key for signaling announcement.
    const rawPub = await crypto.subtle.exportKey('raw', this._depositKeyPair.publicKey)
    this._depositPubKeyB64 = btoa(String.fromCharCode(...new Uint8Array(rawPub)))
  }

  /**
   * Sign `message` with the per-session ECDSA P-256 signing key and return a
   * base64 signature. Ensures the key exists first.
   *
   * @param {string} message
   * @returns {Promise<string>} base64 signature
   */
  async _signDeposit(message) {
    await this._ensureDepositKey()
    const enc = new TextEncoder()
    const sigBuf = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      this._depositKeyPair.privateKey,
      enc.encode(message),
    )
    return btoa(String.fromCharCode(...new Uint8Array(sigBuf)))
  }

  /**
   * Sign RAW bytes (not a JSON string) with the ECDSA identity key, returning a
   * base64 signature. Used to sign the X3DH signed-prekey public key, mirroring
   * how depositPubKey/boxPubKey are bound to this identity.
   *
   * @param {Uint8Array} bytes
   * @returns {Promise<string>}
   */
  async _signDepositRaw(bytes) {
    await this._ensureDepositKey()
    const sigBuf = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      this._depositKeyPair.privateKey,
      bytes,
    )
    return btoa(String.fromCharCode(...new Uint8Array(sigBuf)))
  }

  // ─── X3DH prekeys (forward secrecy) ──────────────────────────────────────────

  /**
   * Lazily create the per-session X3DH prekey store: a signed prekey (signed by
   * the ECDSA identity) plus a one-time-prekey pool. Idempotent.
   */
  async _ensurePreKeys() {
    await this._ensureDepositKey()   // box key + ECDSA identity
    if (this._preKeys) return
    this._preKeys = await PreKeyStore.create(
      (bytes) => this._signDepositRaw(bytes),
      ONE_TIME_PREKEY_POOL,
    )
    const b = this._preKeys.publicBundle(this._peerId)
    this._signedPreKeyPublic = b.signed_prekey
  }

  /**
   * Publish this peer's prekey bundle (signed prekey + one-time-prekey pool) so
   * the host can serve per-sender OPK CLAIMs (Contract A). Best-effort: if the
   * host does not (yet) host /api/peering/prekeys/publish, v2 still works
   * signed-prekey-only via the join-frame announcement.
   */
  async _publishPreKeys() {
    await this._ensurePreKeys()
    const headers = { 'Content-Type': 'application/json' }
    if (this._authToken) headers['Authorization'] = `Bearer ${this._authToken}`
    await fetch(`${this._relayBase}/api/peering/prekeys/publish`, {
      method: 'POST',
      headers,
      body: JSON.stringify(this._preKeys.publicBundle(this._peerId)),
    })
  }

  /**
   * Claim a recipient's prekey bundle for one message (Contract A):
   *   POST /api/peering/prekeys/claim { identity_vula_id }
   *   → { signed_prekey:{id,pub,sig}, one_time_prekey:{id,pub} | null }
   * The host atomically hands out + DELETES the returned OPK (single-use), so two
   * sends to the same recipient get DIFFERENT OPKs (per-sender forward secrecy);
   * `null` when the pool is exhausted (sender falls back to signed-prekey-only).
   *
   * NOTE (divergence from the Go contract): identity_vula_id is the recipient's
   * relay peerId here; the host maps it to the canonical base58 VulaID. Returns
   * null on any error so the caller can fall back.
   *
   * @param {string} toPeerId
   * @returns {Promise<{ signed_prekey?:object, one_time_prekey?:object|null }|null>}
   */
  async _claimPreKeys(toPeerId) {
    try {
      const headers = { 'Content-Type': 'application/json' }
      if (this._authToken) headers['Authorization'] = `Bearer ${this._authToken}`
      const res = await fetch(`${this._relayBase}/api/peering/prekeys/claim`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ identity_vula_id: toPeerId }),
      })
      if (!res || !res.ok) return null
      return await res.json()
    } catch {
      return null
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  _setPeerState(peerId, ps, state) {
    ps.state = state
    this.dispatchEvent(new CustomEvent('state', { detail: { peerId, state } }))
  }

  _sendToPeer(ps, data) {
    if (ps.state === 'connected' && ps.dc && ps.dc.readyState === 'open') {
      ps.dc.send(data)
    } else if (ps.state === 'relay') {
      // Relay path: encode and deposit.
      this._relayDeposit(ps.id, data)
    }
    // 'connecting' / 'disconnected' → silently drop (caller should buffer).
  }
}

// ─── Internal per-peer state ────────────────────────────────────────────────

class PeerState {
  constructor(id) {
    this.id = id
    this.pc = null            // RTCPeerConnection
    this.dc = null            // RTCDataChannel
    this.state = 'disconnected'
    this.relayTimer = null
    this.pendingCandidates = []
    // Reconnect bookkeeping.
    this.reinitTimer = null
    this.reinitDelay = 0
    this.left = false         // peer sent an explicit 'leave' — do not chase it
  }

  reset() {
    clearTimeout(this.relayTimer)
    clearTimeout(this.reinitTimer)
    this.dc?.close()
    this.pc?.close()
    this.pc = null
    this.dc = null
    this.pendingCandidates = []
  }
}
