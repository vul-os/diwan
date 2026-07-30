// no-broker-dep:allow-file: this file's title names Ephor because it implements the HOST_PEERING
// transport (/api/peering/stream), which exists only when a Vulos OS/Ephor host mounts that
// path in front of Diwan — one optional case in transportSelection.js's priority chain, not a
// default or an import of anything named ephor. A standalone Diwan never mounts this path (see
// main.go) and falls through to its own built-in surface.
/**
 * signaling.js — Ephor signalling client for the office suite.
 *
 * Opens a WebSocket to the Vulos OS signaling stream
 * (GET /api/peering/stream) and multiplexes offer/answer/ICE frames
 * over the "signal" channel defined by the OS ws.go Hub.
 *
 * Frame envelope (mirrors ws.go):
 *   { channel: "signal", from: <userID>, payload: <SignalPayload> }
 *
 * SignalPayload:
 *   { type: "offer"|"answer"|"ice"|"join"|"leave",
 *     session: <sessionID>,
 *     to: <peerID>,          // targeted delivery (optional; omit = broadcast)
 *     sdp: <string>,         // offer / answer
 *     candidate: <RTCIceCandidateInit>,
 *     nonce: <uuid>,         // replay-protection nonce (required when sig present)
 *     ts: <number>,          // signed epoch-ms timestamp (required when sig present)
 *     sig: <base64>,         // ECDSA P-256 signature over canonical payload
 *     pubKey: <base64>,      // sender's raw ECDSA public key (offer/answer only)
 *   }
 *
 * ── E2E peer authentication (security audit MEDIUM) ──────────────────────────
 *
 * Problem: the `frame.from` field is stamped by the signaling server.  A
 * malicious server can set any `from` value to misroute or impersonate.
 * The `p.to` delivery filter is not sufficient protection.
 *
 * Solution implemented here:
 *
 *   1. PEER IDENTITY BINDING
 *      Each peer publishes its ECDSA P-256 public key in the "join" frame
 *      (`depositPubKey`).  The key is stored on first use (TOFU).  All
 *      subsequent offer/answer/ice frames from that peer must carry a valid
 *      ECDSA signature over a deterministic canonical message that includes
 *      the `from` field.  A server that stamps the wrong `from` causes the
 *      canonical reconstruction to differ → verification fails → frame dropped.
 *
 *   2. DTLS FINGERPRINT PINNING
 *      The canonical message for offer/answer includes the full SDP string,
 *      which in turn contains the DTLS fingerprint line
 *      (`a=fingerprint:sha-256 …`).  Signing the SDP implicitly pins the
 *      fingerprint: if a MITM signaling server replaces the SDP (and thus the
 *      fingerprint) the signature mismatch causes the frame to be dropped
 *      before `setRemoteDescription` is called.
 *
 *   3. KEY STORAGE MODEL (TOFU)
 *      The first pubkey seen for a given `from` is trusted.  Later joins from
 *      the same peer with a different key are ignored.  The security boundary
 *      is the server's JWT authentication, which binds `from` to an
 *      authenticated identity on the initial join.  A server that is honest at
 *      join time but dishonest later cannot forge frames because it does not
 *      hold the peer's private key.
 *
 *   Backward compatibility: when `signFrame` is null (e.g. fabricSignaling.js
 *   / BroadcastChannel stub), signing is skipped.  When `requirePeerAuth` is
 *   false (default) unsigned frames from peers without a stored key pass
 *   through.  Frames from peers WITH a stored key are always verified
 *   regardless of `requirePeerAuth`.
 */

import { SignalingError } from './errors.js'
import { tokenTransportSecure } from './secureTransport.js'

const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
const RECONNECT_MAX_ATTEMPTS = 10  // after this many failures emit 'offline'
const SIGNAL_CHANNEL = 'signal'

// Maximum seen-(from,nonce) entries across all peers (FIFO eviction at cap).
// 1 000 entries accommodate ≥ 16 concurrent peers each sending ~60 signed
// frames before the oldest entries are evicted.
const NONCE_CACHE_MAX = 1_000

// ─── Replay freshness window ────────────────────────────────────────────────
// A signed frame carries a signed `ts` (epoch ms).  Frames whose timestamp is
// older than MAX_FRAME_AGE_MS, or further in the future than MAX_CLOCK_SKEW_MS,
// are rejected.  This bounds the validity of a captured signed offer/answer/ice
// frame to a small window — without it a captured frame stays valid forever and
// becomes replayable again once its nonce is evicted from the FIFO cache.  The
// nonce cache remains as defense-in-depth against replays inside the window.
const MAX_FRAME_AGE_MS = 30_000
const MAX_CLOCK_SKEW_MS = 5_000

// Prefix for carrying the auth JWT as a WebSocket subprotocol token. The full
// JWT is base64url (chars A-Za-z0-9-_ plus '.' segment separators) and unpadded,
// so `vula.token.<jwt>` is a valid RFC 6455 / RFC 7230 subprotocol token.
//
// ─── Server contract (audit MED — JWT in WS query string) ───────────────────
//   Default transport: the JWT is sent in the `Sec-WebSocket-Protocol` request
//   header, NOT the URL query string (which leaks into access logs, the browser
//   history/Referer, and proxies). The server MUST, during the WS upgrade:
//     1. Read `Sec-WebSocket-Protocol` (a comma-separated list of offered
//        subprotocols).
//     2. Find the entry beginning with `vula.token.`, strip that prefix, and
//        validate the remaining string as the Bearer JWT.
//     3. Complete the upgrade. Echoing a selected subprotocol back is optional
//        for browsers (an omitted response header still completes the
//        handshake); if the server does echo, it should echo a stable protocol
//        name and not the token value.
//   Tokens remain short-lived regardless of transport.
//
//   Legacy fallback: backends that cannot yet read the header may opt the
//   client back into the `?token=` query string by constructing the client with
//   `tokenTransport: 'query'`. This is OFF by default and exists only as a
//   migration shim.
const TOKEN_SUBPROTOCOL_PREFIX = 'vula.token.'

// ─── Canonical signing message ────────────────────────────────────────────────
//
// Deterministic JSON string signed over for offer/answer/ice frames.
// Field insertion order is fixed so sender and receiver produce identical JSON.
// The `from` field is included so a server that stamps the wrong `from` causes
// a canonical-message mismatch and the signature to not verify.
// The `ts` field (epoch ms) is included so the signature also authenticates the
// frame's timestamp, enabling staleness rejection (a tampered ts breaks the sig).
// For offer/answer, including `sdp` also pins the DTLS fingerprint.
//
// @internal — exported only for tests via peer-auth.test.js which re-implements it.
function _canonical({ type, session, to, from, nonce, ts, sdp, candidate, pubKey }) {
  const msg = { type, session, to: to ?? null, from, nonce, ts }
  if (sdp !== undefined) msg.sdp = sdp
  if (candidate !== undefined) msg.candidate = candidate
  if (pubKey !== undefined) msg.pubKey = pubKey
  return JSON.stringify(msg)
}

// ─── Canonical JOIN signing message (anti-downgrade commitment) ──────────────
//
// Deterministic JSON string signed over for the "join" frame.  Unlike
// offer/answer/ice, the join carries the peer's *security-establishing* fields:
// `depositPubKey` (identity), `boxPubKey` (X25519 encryption), `signedPreKey`
// (X3DH prekey enabling FORWARD SECRECY) and a `supportsV2` capability flag.
//
// The signaling/relay server is UNTRUSTED transport.  Without an authenticated
// commitment a malicious server can simply STRIP the `signedPreKey` field from a
// join — the receiver then stores no prekey and the sender silently falls back to
// the v1 static-static path (no forward secrecy).  Forgery is already blocked
// (the SPK carries its own ECDSA signature, verified before storage) but OMISSION
// was not detectable.
//
// Signing this CAPABILITY COMMITMENT with the peer's ECDSA identity key closes
// the hole:
//   • DOWNGRADE: the signed `supportsV2:true` flag commits that the peer is
//     forward-secrecy capable.  A receiver that verifies it PINS the peer as
//     v2-capable; a sender then refuses any v1 path for that peer (fail closed),
//     so a stripped/omitted SPK is treated as an attack rather than legacy.
//   • IDENTITY/BOX BINDING: depositPubKey + boxPubKey are bound to the same
//     signature, so a server cannot swap the encryption key under a v2 claim.
//
// IMPORTANT — the mutable `signedPreKey` is DELIBERATELY NOT part of this
// signature.  The SPK carries its OWN ECDSA signature (`spk.sig`, verified before
// storage), so it is independently authenticated.  Keeping it out of the join
// commitment is what makes a STRIPPED SPK *detectable*: if the SPK were inside
// this signature, stripping it would merely invalidate the whole join sig and the
// peer would look like an unsigned legacy peer (silent downgrade).  By signing
// only the capability, a stripped SPK still leaves a VALID `supportsV2` signature
// → the receiver pins v2 → the absent SPK is caught as a downgrade, not legacy.
//
// Field insertion order is fixed so sender and receiver produce identical JSON.
// `boxPubKey`/`depositPubKey` are normalised to null when absent.
//
// @internal — re-implemented by tests to construct/tamper signed joins.
function _canonicalJoin({ session, from, depositPubKey, boxPubKey, supportsV2, nonce, ts }) {
  return JSON.stringify({
    type: 'join',
    session,
    from,
    depositPubKey: depositPubKey ?? null,
    boxPubKey: boxPubKey ?? null,
    supportsV2: !!supportsV2,
    nonce,
    ts,
  })
}

export class SignalingClient extends EventTarget {
  /**
   * @param {object} opts
   * @param {string}   opts.signalingUrl     - WebSocket URL, e.g. "ws://localhost:8080/api/peering/stream"
   * @param {string}   opts.sessionId        - fabric session / document id
   * @param {string}   opts.peerId           - this client's identity token (injected by auth)
   * @param {string}  [opts.authToken]       - Bearer JWT (if auth is enabled)
   * @param {'subprotocol'|'query'} [opts.tokenTransport='subprotocol']
   *        - how the auth JWT is delivered. 'subprotocol' (default) sends it in
   *          the Sec-WebSocket-Protocol header so it never appears in the URL.
   *          'query' is a legacy migration shim that appends ?token=<jwt> for
   *          backends that cannot yet read the header — see the server contract
   *          note at the top of this file.
   * @param {number}  [opts.maxAttempts]     - max reconnect attempts before 'offline' (default 10)
   * @param {() => (string|null)} [opts.getDepositPubKey]
   *        - optional callback returning this peer's base64 raw deposit signing
   *          public key. When it returns a non-null value, the key is published
   *          in the "join" frame so the server can bind it to the authenticated
   *          peerId and verify deposit signatures.
   * @param {() => (string|null)} [opts.getBoxPubKey]
   *        - optional callback returning this peer's base64 raw X25519 box
   *          (encryption) public key. When non-null it is published in the
   *          "join" frame as `boxPubKey` and stored TOFU by receivers so they
   *          can encrypt relay-fallback payloads to this peer end-to-end (the
   *          relay server never sees the box private key, so it cannot read the
   *          relayed content). Mirrors the depositPubKey exchange.
   * @param {((msg: string) => Promise<string>)|null} [opts.signFrame]
   *        - optional async callback that signs a canonical string and returns a
   *          base64 ECDSA signature. When provided, all outgoing offer/answer/ice
   *          frames are signed. Typically wired to FabricClient._signDeposit().
   * @param {boolean} [opts.requirePeerAuth=false]
   *        - when true, offer/answer/ice frames from peers with no stored public
   *          key are dropped (no TOFU fallback for unknown peers). Frames from
   *          peers with a stored key are ALWAYS verified regardless of this flag.
   *          Set to true in FabricClient for E2E peer authentication.
   */
  constructor({
    signalingUrl,
    sessionId,
    peerId,
    authToken = null,
    tokenTransport = 'subprotocol',
    maxAttempts = RECONNECT_MAX_ATTEMPTS,
    getDepositPubKey = null,
    getBoxPubKey = null,
    getSignedPreKey = null,
    signFrame = null,
    requirePeerAuth = false,
  }) {
    super()

    // ── Credential-transport guard (security: plaintext token leak) ──────────
    // The auth JWT rides on this socket (subprotocol header or, legacily, the
    // query string). If the signaling URL is plaintext ws:// to a non-loopback
    // host the token would travel in the clear — readable on-path and captured
    // in proxy/access logs. Refuse to construct a client that would leak it
    // (fail closed): wss:// is required; ws:// is permitted only to a loopback
    // host for local dev. A client with NO token may use ws:// freely — the
    // signaling frames are ECDSA-signed, so there is no credential to protect.
    if (authToken && !tokenTransportSecure(signalingUrl)) {
      throw new SignalingError(
        'refusing to attach the auth token to an insecure signaling transport: ' +
        'wss:// is required (ws:// is permitted only to a loopback host for local dev)',
        { code: 'INSECURE_TOKEN_TRANSPORT' },
      )
    }

    this._url = signalingUrl
    this._session = sessionId
    this._peerId = peerId
    this._authToken = authToken
    this._tokenTransport = tokenTransport === 'query' ? 'query' : 'subprotocol'
    this._getDepositPubKey = getDepositPubKey
    this._getBoxPubKey = getBoxPubKey
    this._getSignedPreKey = getSignedPreKey
    this._signFrame = signFrame
    this._requirePeerAuth = requirePeerAuth
    this._ws = null
    this._reconnectDelay = RECONNECT_BASE_MS
    this._reconnectAttempts = 0
    this._maxAttempts = maxAttempts
    this._stopped = false
    this._degraded = false

    // ── E2E peer key registry (TOFU) ─────────────────────────────────────────
    // Maps peerId → imported CryptoKey (ECDSA P-256 public key).
    // Populated on receiving 'join' frames that carry depositPubKey.
    // Also populated on first offer/answer receipt when the frame carries pubKey.
    // First key seen wins; subsequent different keys for the same peer are ignored.
    /** @type {Map<string, CryptoKey>} */
    this._peerKeys = new Map()

    // ── E2E peer box-key registry (TOFU) ─────────────────────────────────────
    // Maps peerId → base64 raw X25519 public key, announced via the peer's
    // 'join' frame (boxPubKey).  Used by FabricClient to encrypt relay-fallback
    // payloads to the peer.  First key seen wins (same TOFU model as _peerKeys).
    /** @type {Map<string, string>} */
    this._peerBoxKeys = new Map()

    // ── E2E peer signed-prekey registry (TOFU + ECDSA-verified) ──────────────
    // Maps peerId → { id, pub, sig } (base64), announced via the peer's 'join'
    // frame (signedPreKey).  Stored ONLY after the signature verifies against the
    // peer's ECDSA deposit key, so a forged signed prekey is rejected (the JS
    // analog of prekeys.go VerifySignedPreKey).  Enables the forward-secret v2
    // (X3DH) relay path: senders run X3DHInitiate against this signed prekey.
    /** @type {Map<string, { id: string, pub: string, sig: string }>} */
    this._peerSignedPreKeys = new Map()

    // ── Anti-downgrade: pinned v2 (forward-secrecy) capability ───────────────
    // Maps peerId → true once we hold CRYPTOGRAPHIC PROOF the peer supports the
    // forward-secret v2 (X3DH) relay path.  Proof comes from any of:
    //   (a) a join whose ECDSA signature over a `supportsV2:true` commitment
    //       verifies (see _canonicalJoin),
    //   (b) a successfully ECDSA-verified signedPreKey (join frame or claim) —
    //       a v1-only legacy peer never produces a validly-signed prekey.
    // Once pinned, FabricClient MUST NOT seal to this peer over v1 static-static:
    // a missing/stripped signed prekey for a pinned peer is a DOWNGRADE ATTACK by
    // the untrusted server, and the sender fails closed instead of dropping FS.
    // Peers that never present a signed v2 commitment stay unpinned → genuine
    // legacy v1 peers keep interoperating.
    /** @type {Map<string, true>} */
    this._peerV2Capable = new Map()

    // ── Replay protection: bounded seen-(from,nonce) cache ───────────────────
    // Stores composite keys "<from>:<nonce>" for every successfully-verified
    // signed frame.  FIFO eviction when the Map exceeds NONCE_CACHE_MAX entries
    // (Map preserves insertion order; keys().next().value is the oldest entry).
    // Only populated after a successful signature check — unsigned frames on the
    // requirePeerAuth=false path are not cached, avoiding cache poisoning.
    /** @type {Map<string, true>} */
    this._seenNonces = new Map()
  }

  /** Connect (or reconnect) to the signaling WebSocket. */
  connect() {
    if (this._stopped) return

    // Default: carry the JWT as a WebSocket subprotocol so it never lands in the
    // URL (and thus access logs / Referer / history). 'query' is a legacy shim.
    let ws
    if (this._authToken && this._tokenTransport === 'subprotocol') {
      ws = new WebSocket(this._url, [TOKEN_SUBPROTOCOL_PREFIX + this._authToken])
    } else if (this._authToken && this._tokenTransport === 'query') {
      ws = new WebSocket(`${this._url}?token=${encodeURIComponent(this._authToken)}`)
    } else {
      ws = new WebSocket(this._url)
    }
    this._ws = ws

    ws.addEventListener('open', async () => {
      this._reconnectDelay = RECONNECT_BASE_MS
      this._reconnectAttempts = 0
      this._degraded = false
      this.dispatchEvent(new CustomEvent('signaling-open'))
      // Announce ourselves to the session room (see _buildJoinPayload). When
      // signFrame is null the join is sent SYNCHRONOUSLY (no await reached), so a
      // consumer that inspects the socket right after 'open' sees it immediately.
      if (this._signFrame) {
        this._buildJoinPayload().then((join) => this._send(join))
      } else {
        this._send(this._buildJoinBase().join)
      }
    })

    ws.addEventListener('message', async (ev) => {
      let frame
      try { frame = JSON.parse(ev.data) } catch { return }
      if (frame.channel !== SIGNAL_CHANNEL) return
      // Delegate to the transport-agnostic processor: the server stamps `from`,
      // so `frame.from` is the sender peerId.
      await this._processSignal(frame.from, frame.payload)
    })

    ws.addEventListener('close', () => {
      if (this._stopped) return
      this.dispatchEvent(new CustomEvent('signaling-close'))
      this._scheduleReconnect()
    })

    ws.addEventListener('error', () => {
      // 'close' will follow; handled there.
    })
  }

  /**
   * Process one inbound SignalPayload from `senderPeerId`, applying the full E2E
   * peer-authentication pipeline (TOFU key/box/prekey import, signed-join
   * anti-downgrade pinning, offer/answer/ice signature + freshness + replay
   * checks) and dispatching a `signal` event to the consumer (FabricClient).
   *
   * This is TRANSPORT-AGNOSTIC: the WebSocket message handler calls it with the
   * server-stamped `from`, and the rendezvous transport (rendezvousSignaling.js)
   * calls it with the sender peerId carried in the opaque rendezvous envelope.
   * The peer-auth handshake is therefore identical end-to-end regardless of
   * whether frames arrive over the host box's WebSocket or a relay's rendezvous
   * signal queue.
   *
   * @param {string} senderPeerId - the sender's application peer id
   * @param {object} p            - the SignalPayload (offer/answer/ice/join/leave)
   */
  async _processSignal(senderPeerId, p) {
    // Only deliver frames addressed to this session and this peer (or broadcast).
    if (!p) return
    if (p.session && p.session !== this._session) return
    if (p.to && p.to !== this._peerId) return

    // ── TOFU key import on 'join' ───────────────────────────────────────────
      // When a peer announces with a depositPubKey, store it (first key wins).
      // This is the primary identity-binding step: the server's JWT auth ensures
      // `from` is the authenticated peerId; we bind their pubkey to that identity.
      if (p.type === 'join' && p.depositPubKey) {
        if (!this._peerKeys.has(senderPeerId)) {
          try {
            const key = await this._importPeerKey(p.depositPubKey)
            this._peerKeys.set(senderPeerId, key)
          } catch { /* invalid key format — ignore */ }
        }
      }

      // ── TOFU box-key import on 'join' ───────────────────────────────────────
      // Store the peer's X25519 encryption public key so FabricClient can seal
      // relay-fallback payloads to it.  First key wins (same TOFU model as
      // depositPubKey); a later differing key from a dishonest server is ignored.
      if (p.type === 'join' && p.boxPubKey) {
        if (!this._peerBoxKeys.has(senderPeerId)) {
          this._peerBoxKeys.set(senderPeerId, p.boxPubKey)
        }
      }

      // ── Signed-prekey import on 'join' (ECDSA-verified, TOFU) ───────────────
      // Store the peer's signed prekey for the forward-secret v2 (X3DH) relay
      // path — but ONLY if its signature verifies against the peer's ECDSA
      // deposit key (which must already be stored from depositPubKey above).
      // Fail closed: a signed prekey we cannot verify is dropped, so a malicious
      // server cannot inject a prekey it controls to weaken FS.
      if (p.type === 'join' && p.signedPreKey && !this._peerSignedPreKeys.has(senderPeerId)) {
        const spk = p.signedPreKey
        const ecdsaKey = this._peerKeys.get(senderPeerId)
        if (ecdsaKey && spk && typeof spk.pub === 'string' && typeof spk.sig === 'string') {
          try {
            const pubBytes = Uint8Array.from(atob(spk.pub), c => c.charCodeAt(0))
            const ok = await this._verifyRaw(ecdsaKey, pubBytes, spk.sig)
            if (ok) {
              this._peerSignedPreKeys.set(senderPeerId, { id: spk.id, pub: spk.pub, sig: spk.sig })
              // A validly-signed prekey is itself proof of v2 capability — a
              // v1-only legacy peer cannot produce one.  Pin so a later stripped
              // SPK (e.g. on reconnect) cannot silently downgrade this peer.
              this._peerV2Capable.set(senderPeerId, true)
            }
          } catch { /* malformed — drop */ }
        }
      }

      // ── Anti-downgrade: verify the signed join + PIN v2 capability ──────────
      // A join that carries a `supportsV2:true` flag plus a `sig` is a signed
      // CAPABILITY commitment (see _canonicalJoin) that the peer is
      // forward-secrecy capable.  Verify it against the peer's ECDSA identity key
      // (imported above).  The signature covers supportsV2 + depositPubKey +
      // boxPubKey but NOT the mutable signedPreKey, so a server that STRIPS the
      // signedPreKey leaves this commitment intact → it still verifies → the peer
      // is PINNED v2-capable while no SPK was stored → FabricClient then catches
      // the absent SPK as a downgrade (fail closed) instead of using v1.  A
      // verified join thus pins v2; FabricClient refuses any later v1 path.
      if (p.type === 'join' && p.sig && p.supportsV2 === true &&
          typeof p.nonce === 'string' && typeof p.ts === 'number') {
        const ecdsaKey = this._peerKeys.get(senderPeerId)
        if (ecdsaKey) {
          const canonical = _canonicalJoin({
            session: p.session,
            from: senderPeerId,
            depositPubKey: p.depositPubKey,
            boxPubKey: p.boxPubKey,
            supportsV2: p.supportsV2,
            nonce: p.nonce,
            ts: p.ts,
          })
          let valid = false
          try { valid = await this._verifyFrame(ecdsaKey, canonical, p.sig) } catch { valid = false }
          // Freshness: bound the validity of a captured join so a stale signed
          // join cannot be replayed indefinitely (mirrors offer/answer/ice).
          const _now = Date.now()
          const fresh = !(p.ts > _now + MAX_CLOCK_SKEW_MS || _now - p.ts > MAX_FRAME_AGE_MS)
          const _nonceKey = `join:${senderPeerId}:${p.nonce}`
          const replay = this._seenNonces.has(_nonceKey)
          if (valid && fresh && !replay) {
            if (this._seenNonces.size >= NONCE_CACHE_MAX) {
              this._seenNonces.delete(this._seenNonces.keys().next().value)
            }
            this._seenNonces.set(_nonceKey, true)
            this._peerV2Capable.set(senderPeerId, true)   // PIN: no downgrade hereafter
          }
          // valid===false → tampered/stripped security fields: do NOT pin, do NOT
          // trust this join's claims (fail closed).
        }
      }

      // ── Signature verification for offer / answer / ice ─────────────────────
      // These frame types carry signed payloads when the sender uses signFrame.
      // Verification uses the stored pubkey for the server-stamped `from`.
      // If the server stamps the wrong `from`, the canonical message differs
      // from what was signed → mismatch → frame dropped.
      if (p.type === 'offer' || p.type === 'answer' || p.type === 'ice') {
        let verifyKey = this._peerKeys.get(senderPeerId) || null

        // offer/answer frames carry the sender's pubkey so we can verify even
        // before their 'join' was received (handles out-of-order delivery).
        // Key is stored TOFU: only if we don't already have one for this peer.
        if (!verifyKey && p.pubKey) {
          try {
            verifyKey = await this._importPeerKey(p.pubKey)
            this._peerKeys.set(senderPeerId, verifyKey)
          } catch { verifyKey = null }
        }

        if (verifyKey) {
          // We have a key for this peer — enforce signature verification.
          // Unsigned frames (no sig/nonce) from a known peer are rejected:
          // they indicate either a replay of an old pre-auth frame or a server
          // injecting an unsigned frame under a previously-trusted identity.
          if (!p.sig || !p.nonce || typeof p.ts !== 'number') {
            // Drop: unsigned or un-timestamped frame from a peer whose key we
            // hold.  A signed frame MUST carry both a nonce and a signed ts so
            // it can be freshness-checked; absence indicates a pre-fix replay or
            // a server injecting a frame under a previously-trusted identity.
            return
          }
          const canonical = _canonical({
            type: p.type,
            session: p.session,
            to: p.to,
            from: senderPeerId,
            nonce: p.nonce,
            ts: p.ts,
            sdp: p.sdp,
            candidate: p.candidate,
            pubKey: p.pubKey,
          })
          const valid = await this._verifyFrame(verifyKey, canonical, p.sig)
          if (!valid) {
            // Signature mismatch — impersonation attempt or MITM SDP/candidate
            // swap (or a tampered ts).  Drop silently to avoid leaking timing.
            return
          }
          // ── Freshness check (replay window) ──────────────────────────────────
          // The ts is now authenticated by the verified signature, so we can
          // trust it.  Reject frames outside the bounded clock-skew window: a
          // captured frame replayed later than MAX_FRAME_AGE_MS is dropped here
          // even if its nonce has since been evicted from the FIFO cache.
          const _now = Date.now()
          if (p.ts > _now + MAX_CLOCK_SKEW_MS || _now - p.ts > MAX_FRAME_AGE_MS) {
            return  // stale or implausibly-future frame — drop
          }
          // ── Replay protection ────────────────────────────────────────────────
          // A replayed frame has a valid signature but a nonce we have already
          // processed.  Check after verification so we only track nonces for
          // authenticated peers and never poison the cache on the unsigned path.
          const _nonceKey = `${senderPeerId}:${p.nonce}`
          if (this._seenNonces.has(_nonceKey)) {
            return  // replay — silently drop
          }
          // FIFO eviction: oldest entry is keys().next().value in insertion order
          if (this._seenNonces.size >= NONCE_CACHE_MAX) {
            this._seenNonces.delete(this._seenNonces.keys().next().value)
          }
          this._seenNonces.set(_nonceKey, true)
        } else if (this._requirePeerAuth) {
          // requirePeerAuth=true but no key available for this peer.  Drop to
          // prevent a server from injecting frames for a peer that hasn't
          // completed a keyed join.
          return
        }
        // else: no key, requirePeerAuth=false → allow through for backward
        // compatibility (fabricSignaling.js / BroadcastChannel paths).
      }

    this.dispatchEvent(new CustomEvent('signal', { detail: { from: senderPeerId, payload: p } }))
  }

  /**
   * Send a signal payload to a specific peer (or broadcast to session).
   *
   * When `signFrame` is configured, the payload is signed with a per-frame
   * nonce using ECDSA P-256.  The nonce is included in both the canonical
   * signing message and the sent payload so recipients can verify.
   *
   * @returns {Promise<void>}
   */
  async signal(type, toId, data = {}) {
    this._send(await this._buildSignalPayload(type, toId, data))
  }

  /**
   * Build (and, when `signFrame` is configured, ECDSA-sign) a SignalPayload for
   * `type`/`toId`/`data`. Pure — it does not touch the transport, so it is shared
   * by the WebSocket `signal()` above and the rendezvous transport, which sends
   * the returned payload as an opaque blob rather than a WS frame. The canonical
   * signed bytes are identical on both paths, so peer authentication is unchanged.
   *
   * @param {string} type - offer | answer | ice
   * @param {string} toId - recipient peerId
   * @param {object} data - { sdp?, candidate?, pubKey? }
   * @returns {Promise<object>} the (possibly signed) SignalPayload
   */
  async _buildSignalPayload(type, toId, data = {}) {
    const payload = { type, session: this._session, to: toId, ...data }

    if (this._signFrame) {
      const nonce = crypto.randomUUID()
      const ts = Date.now()
      payload.nonce = nonce
      payload.ts = ts
      // Build canonical message — field order is fixed (see _canonical).
      // Including `from` binds the sender's identity: a server that stamps the
      // wrong `from` causes the receiver's canonical reconstruction to differ.
      // Including `ts` lets the receiver reject stale (captured) frames.
      // Including `sdp` (for offer/answer) pins the DTLS fingerprint.
      const canonical = _canonical({
        type,
        session: this._session,
        to: toId,
        from: this._peerId,
        nonce,
        ts,
        sdp: data.sdp,
        candidate: data.candidate,
        pubKey: data.pubKey,
      })
      payload.sig = await this._signFrame(canonical)
    }

    return payload
  }

  /**
   * Build (and, when `signFrame` is configured, ECDSA-sign) this peer's `join`
   * announcement payload — the deposit/box/signed-prekey public keys plus the
   * signed `supportsV2` anti-downgrade commitment. Pure (no transport), so both
   * the WebSocket open handler and the rendezvous transport publish the identical
   * signed join: over WS it is a room broadcast; over rendezvous it is deposited
   * onto the session's shared discovery board.
   *
   * @returns {Promise<object>} the (possibly signed) join payload
   */
  async _buildJoinPayload() {
    const { join, depositPubKey, boxPubKey, supportsV2 } = this._buildJoinBase()
    if (this._signFrame) {
      const nonce = crypto.randomUUID()
      const ts = Date.now()
      join.nonce = nonce
      join.ts = ts
      const canonical = _canonicalJoin({
        session: this._session,
        from: this._peerId,
        depositPubKey,
        boxPubKey,
        supportsV2,
        nonce,
        ts,
      })
      join.sig = await this._signFrame(canonical)
    }
    return join
  }

  /**
   * Build the UNSIGNED base join object plus the derived key fields the signing
   * step needs. Synchronous, so the WebSocket open handler can send an unsigned
   * join without awaiting (preserving the historical synchronous-send behaviour).
   *
   * @returns {{ join: object, depositPubKey: string|null, boxPubKey: string|null, supportsV2: boolean }}
   */
  _buildJoinBase() {
    // Publish the deposit signing public key (when available) so the server can
    // bind it to our authenticated peerId and verify relay deposit signatures.
    const join = { type: 'join', session: this._session }
    const depositPubKey = this._getDepositPubKey?.() ?? null
    if (depositPubKey) join.depositPubKey = depositPubKey
    const boxPubKey = this._getBoxPubKey?.() ?? null
    if (boxPubKey) join.boxPubKey = boxPubKey
    // Publish the signed prekey {id, pub, sig} so peers can establish a
    // forward-secret (X3DH/v2) relay session. The pub is signed by our ECDSA
    // identity (mirroring boxPubKey/depositPubKey); peers verify it before use.
    const signedPreKey = this._getSignedPreKey?.() ?? null
    if (signedPreKey) join.signedPreKey = signedPreKey

    // ── Anti-downgrade: authenticate forward-secrecy capability ────────────
    // When we can sign (signFrame wired) AND we have a signed prekey, advertise
    // forward-secrecy capability with a SIGNED `supportsV2:true` commitment —
    // an ECDSA signature over supportsV2 + depositPubKey + boxPubKey + nonce/ts
    // (see _canonicalJoin).  The mutable signedPreKey is authenticated by its
    // OWN sig, so a server that strips it leaves this commitment intact: the
    // receiver still verifies supportsV2, pins us as v2-capable, and catches the
    // absent prekey as a downgrade instead of treating us as legacy.
    const supportsV2 = !!(this._signFrame && signedPreKey)
    if (supportsV2) join.supportsV2 = true
    return { join, depositPubKey, boxPubKey, supportsV2 }
  }

  /** Cleanly stop reconnecting and close the socket. */
  close() {
    this._stopped = true
    if (this._ws) {
      this._send({ type: 'leave', session: this._session })
      this._ws.close()
      this._ws = null
    }
  }

  // ─── public peer-key helpers (used by FabricClient for relay-blob auth) ────

  /**
   * Return true when a public key has been stored for `fromPeerId` (via a
   * 'join' frame or TOFU import on an offer/answer).
   *
   * Used by FabricClient to decide whether to enforce a relay-blob signature.
   *
   * @param {string} fromPeerId
   * @returns {boolean}
   */
  hasPeerKey(fromPeerId) {
    return this._peerKeys.has(fromPeerId)
  }

  /**
   * Return the stored base64 X25519 box (encryption) public key for `peerId`,
   * announced in that peer's 'join' frame, or null if none is known yet.
   *
   * Used by FabricClient to seal relay-fallback payloads end-to-end.
   *
   * @param {string} peerId
   * @returns {string|null}
   */
  getPeerBoxKey(peerId) {
    return this._peerBoxKeys.get(peerId) ?? null
  }

  /**
   * Return the stored, ECDSA-verified signed prekey {id, pub, sig} for `peerId`
   * (announced in their 'join' frame), or null if none is known/verified yet.
   *
   * Used by FabricClient to establish a forward-secret (X3DH/v2) relay session.
   *
   * @param {string} peerId
   * @returns {{ id: string, pub: string, sig: string }|null}
   */
  getPeerSignedPreKey(peerId) {
    return this._peerSignedPreKeys.get(peerId) ?? null
  }

  /**
   * Whether `peerId` has been PINNED as forward-secrecy (v2/X3DH) capable via a
   * cryptographic commitment: a verified signed join (`supportsV2:true`) or a
   * verified signed prekey (join frame or claim).  Once true it never reverts —
   * a subsequently-missing signed prekey for this peer is a downgrade ATTACK, not
   * a legacy peer, and FabricClient must fail closed rather than seal over v1.
   *
   * @param {string} peerId
   * @returns {boolean}
   */
  isPeerV2Capable(peerId) {
    return this._peerV2Capable.get(peerId) === true
  }

  /**
   * Verify a signed prekey {pub, sig} (base64) against the stored ECDSA key for
   * `peerId`. Returns false if no key is held or the signature is invalid (fail
   * closed). Used for prekeys obtained via the claim endpoint (Contract A), which
   * did not pass through the join-frame verification path.
   *
   * @param {string} peerId
   * @param {{ pub: string, sig: string }} signedPreKey
   * @returns {Promise<boolean>}
   */
  async verifyPeerSignedPreKey(peerId, signedPreKey) {
    const key = this._peerKeys.get(peerId)
    if (!key || !signedPreKey || typeof signedPreKey.pub !== 'string' || typeof signedPreKey.sig !== 'string') {
      return false
    }
    try {
      const pubBytes = Uint8Array.from(atob(signedPreKey.pub), c => c.charCodeAt(0))
      if (pubBytes.length !== 32) return false
      const ok = await this._verifyRaw(key, pubBytes, signedPreKey.sig)
      // A signed prekey that verifies (here, obtained via the single-use claim
      // endpoint) proves v2 capability — pin so a later stripped SPK for this
      // peer is treated as a downgrade attack, not a legacy peer.
      if (ok) this._peerV2Capable.set(peerId, true)
      return ok
    } catch {
      return false
    }
  }

  /**
   * Verify a relay-deposit blob signature using the stored public key for
   * `fromPeerId` (populated via signaling join / TOFU).
   *
   * @param {string} fromPeerId
   * @param {string} message   — the exact canonical string that was signed
   * @param {string} sigB64    — base64 ECDSA P-256 DER signature
   * @returns {Promise<boolean|null>}
   *   true  — valid signature
   *   false — invalid signature (impersonation / tamper → drop blob)
   *   null  — no key stored for this peer (caller applies its own policy)
   */
  async verifyPeerSig(fromPeerId, message, sigB64) {
    const key = this._peerKeys.get(fromPeerId)
    if (!key) return null
    return this._verifyFrame(key, message, sigB64)
  }

  // ─── private ───────────────────────────────────────────────────────────────

  _send(payload) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return
    const frame = JSON.stringify({
      channel: SIGNAL_CHANNEL,
      payload,
    })
    this._ws.send(frame)
  }

  _scheduleReconnect() {
    this._reconnectAttempts++

    // Once the budget is exhausted, emit a terminal 'offline' event so
    // consumers can show a degraded-mode banner rather than waiting forever.
    if (this._reconnectAttempts >= this._maxAttempts) {
      if (!this._degraded) {
        this._degraded = true
        this.dispatchEvent(new CustomEvent('offline', {
          detail: { attempts: this._reconnectAttempts },
        }))
      }
      // Continue trying — but at the max delay — so the connection recovers
      // automatically when the network comes back, while consumers know we are
      // in degraded mode.
    }

    const delay = this._reconnectDelay
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, RECONNECT_MAX_MS)
    setTimeout(() => this.connect(), delay)
  }

  // ── E2E crypto helpers ─────────────────────────────────────────────────────

  /**
   * Import a base64-encoded raw ECDSA P-256 public key as a CryptoKey for
   * verification only.
   *
   * @param {string} b64PubKey  — base64 raw public key (65 bytes uncompressed)
   * @returns {Promise<CryptoKey>}
   */
  async _importPeerKey(b64PubKey) {
    const raw = Uint8Array.from(atob(b64PubKey), c => c.charCodeAt(0))
    return crypto.subtle.importKey(
      'raw',
      raw,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
  }

  /**
   * Verify a base64-encoded ECDSA P-256 signature over `canonical` using
   * `pubKey`.  Returns false on any error (malformed sig, wrong key, etc.)
   * so callers can treat it as a boolean rejection.
   *
   * @param {CryptoKey} pubKey
   * @param {string}    canonical  — deterministic JSON string that was signed
   * @param {string}    sigB64     — base64 ECDSA signature
   * @returns {Promise<boolean>}
   */
  async _verifyFrame(pubKey, canonical, sigB64) {
    return this._verifyRaw(pubKey, new TextEncoder().encode(canonical), sigB64)
  }

  /**
   * Verify a base64 ECDSA P-256 signature over RAW message bytes using `pubKey`.
   * Used both for canonical-string frame sigs and for the signed-prekey sig
   * (which is over the 32-byte X25519 public key). Returns false on any error.
   *
   * @param {CryptoKey} pubKey
   * @param {Uint8Array} msgBytes
   * @param {string} sigB64
   * @returns {Promise<boolean>}
   */
  async _verifyRaw(pubKey, msgBytes, sigB64) {
    try {
      const sigBuf = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0))
      return await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        pubKey,
        sigBuf,
        msgBytes,
      )
    } catch {
      return false
    }
  }
}
