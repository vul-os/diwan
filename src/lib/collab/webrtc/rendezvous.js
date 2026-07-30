// no-broker-dep:allow-file: this is the reference client for the OPEN rendezvous role
// (implemented by any conforming vulos-relayd, or by Diwan's OWN backend/rendezvous — the
// default path). It is a protocol client the app calls at a URL the operator supplies; there
// is no default endpoint (RendezvousURL defaults empty, verified by
// backend/config/config_test.go's TestDefault_RendezvousURLEmpty).
//
// rendezvous.js — the reference JS client for the OPEN rendezvous role served by
// any vulos-relayd (self-hosted or Vulos-run) under its /rendezvous prefix.
//
// It speaks the key-addressed announce / resolve / signal / mailbox + ICE protocol
// documented in the relay repo's docs/RENDEZVOUS.md, so an app gets peer discovery
// and content-opaque WebRTC signaling from ANY conforming node — no Vulos OS and no
// host-box /api/peering/* backend required. The existing FabricClient host-box path
// keeps working unchanged; this is an ADDITIONAL transport you point at a relay.
//
// IDENTITY: every participant is an Ed25519 keypair. This module signs writes with
// Ed25519 (via @noble/curves) over the SAME domain-separated, length-prefixed
// canonical message the Go node verifies — so a browser client and a relayd
// interoperate byte-for-byte. (Note: this is a distinct identity from FabricClient's
// per-session ECDSA-P256 signaling key; the rendezvous role is Ed25519 end to end.)
//
// CONTENT-BLIND: payloads (offer/answer/ICE, mailbox blobs) are opaque base64url
// bytes the relay never inspects. Encrypt them at the app layer before deposit; the
// relay only moves bytes keyed by public key.

import { ed25519 } from '@noble/curves/ed25519.js'
import { RelayDepositError } from './errors.js'
import { tokenTransportSecure } from './secureTransport.js'

// ── canonical domain tags (MUST match tunnel/rendezvous/service.go) ───────────
const DOMAIN = {
  announce: 'vulos-rdv/announce/1',
  withdraw: 'vulos-rdv/withdraw/1',
  signalDeposit: 'vulos-rdv/signal-deposit/1',
  signalPoll: 'vulos-rdv/signal-poll/1',
  signalAck: 'vulos-rdv/signal-ack/1',
  mailboxDeposit: 'vulos-rdv/mailbox-deposit/1',
  mailboxPoll: 'vulos-rdv/mailbox-poll/1',
  mailboxAck: 'vulos-rdv/mailbox-ack/1',
}

// ── base64url (unpadded) — the single binary encoding on the wire ─────────────

/** Encode bytes to unpadded base64url. */
export function b64urlEncode(bytes) {
  let bin = ''
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Decode unpadded base64url to bytes. */
export function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4))
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const utf8 = new TextEncoder()

/**
 * Build the canonical signing message: for the domain tag and then each string
 * field in order, write a 4-byte big-endian length followed by the field's UTF-8
 * bytes. Byte-for-byte identical to canonicalMessage() in the Go node, so a
 * signature made here verifies there and vice-versa. All fields are strings
 * (binary as base64url, numbers as base-10).
 */
export function canonicalMessage(domain, fields) {
  const segs = [domain, ...fields].map((s) => utf8.encode(String(s)))
  let total = 0
  for (const s of segs) total += 4 + s.length
  const buf = new Uint8Array(total)
  const dv = new DataView(buf.buffer)
  let off = 0
  for (const s of segs) {
    dv.setUint32(off, s.length, false) // big-endian
    off += 4
    buf.set(s, off)
    off += s.length
  }
  return buf
}

// ── identity ──────────────────────────────────────────────────────────────────

/**
 * An Ed25519 identity used to sign rendezvous writes. Wrap an existing 32-byte
 * secret key, or call RendezvousIdentity.generate() for a fresh one.
 */
export class RendezvousIdentity {
  /** @param {Uint8Array} secretKey - 32-byte Ed25519 seed/secret */
  constructor(secretKey) {
    this.secretKey = secretKey instanceof Uint8Array ? secretKey : new Uint8Array(secretKey)
    this.publicKey = ed25519.getPublicKey(this.secretKey)
    /** canonical base64url public key — the address of this identity */
    this.key = b64urlEncode(this.publicKey)
  }

  static generate() {
    return new RendezvousIdentity(ed25519.utils.randomSecretKey())
  }

  /** Sign a canonical message; returns the signature as base64url. */
  sign(msg) {
    return b64urlEncode(ed25519.sign(msg, this.secretKey))
  }
}

/** Fresh random nonce (base64url of 16 bytes) for replay protection. */
export function randomNonce() {
  const b = new Uint8Array(16)
  globalThis.crypto.getRandomValues(b)
  return b64urlEncode(b)
}

function nowUnix() {
  return Math.floor(Date.now() / 1000)
}

// ── client ──────────────────────────────────────────────────────────────────

/**
 * RendezvousClient talks to a single relayd's rendezvous surface.
 *
 * @example
 *   const id = RendezvousIdentity.generate()
 *   const rdv = new RendezvousClient({ baseUrl: 'https://relay.example.com', identity: id })
 *   await rdv.announce({ endpoints: ['wss://mybox/tunnel'], ttl: 300 })
 *   const peer = await rdv.resolve(peerKey)         // { online, endpoints, meta }
 *   await rdv.signalDeposit(peerKey, offerBytes)    // opaque WebRTC offer
 *   const msgs = await rdv.signalPoll({ wait: 20 }) // long-poll my inbox
 *   await rdv.signalAck(msgs.map(m => m.id))
 */
export class RendezvousClient {
  /**
   * @param {object} opts
   * @param {string}  opts.baseUrl   - relay origin, e.g. "https://relay.example.com"
   * @param {RendezvousIdentity} opts.identity - this peer's Ed25519 identity
   * @param {string} [opts.prefix]   - mount prefix (default "/rendezvous")
   * @param {string} [opts.authToken]- optional Bearer token for the relay's own
   *                                    gate (the rendezvous protocol itself is
   *                                    signature-authenticated; a token is only for
   *                                    a paid/gated relay's edge). Refused on an
   *                                    insecure (plaintext non-loopback) baseUrl.
   * @param {typeof fetch} [opts.fetch] - injectable fetch (tests)
   */
  constructor({ baseUrl, identity, prefix = '/rendezvous', authToken = null, fetch: fetchImpl } = {}) {
    if (!baseUrl) throw new RelayDepositError('rendezvous: baseUrl is required', { code: 'NO_BASE_URL' })
    if (!(identity instanceof RendezvousIdentity)) {
      throw new RelayDepositError('rendezvous: identity (RendezvousIdentity) is required', { code: 'NO_IDENTITY' })
    }
    if (authToken && !tokenTransportSecure(baseUrl)) {
      throw new RelayDepositError(
        'refusing to attach the auth token to an insecure rendezvous base URL: https:// is required (http:// only to loopback)',
        { code: 'INSECURE_TOKEN_TRANSPORT' },
      )
    }
    this.baseUrl = String(baseUrl).replace(/\/+$/, '')
    this.prefix = '/' + String(prefix).replace(/^\/+|\/+$/g, '')
    this.identity = identity
    this.key = identity.key
    this._authToken = authToken
    this._fetch = fetchImpl || ((...a) => (globalThis.fetch)(...a))
  }

  /**
   * Return a new RendezvousClient that talks to the SAME relay (base URL, mount
   * prefix, auth token, fetch impl) under a DIFFERENT Ed25519 identity. Used by
   * the rendezvous signaling transport to hold both a per-peer "self" client and
   * a session-derived "room" client (whose private key every session member can
   * derive) against one relay without re-plumbing the transport config.
   *
   * @param {RendezvousIdentity} identity
   * @returns {RendezvousClient}
   */
  withIdentity(identity) {
    return new RendezvousClient({
      baseUrl: this.baseUrl,
      identity,
      prefix: this.prefix,
      authToken: this._authToken,
      fetch: this._fetch,
    })
  }

  _url(path) {
    return this.baseUrl + this.prefix + path
  }

  _headers() {
    const h = { 'Content-Type': 'application/json' }
    if (this._authToken) h.Authorization = `Bearer ${this._authToken}`
    return h
  }

  async _postJSON(path, body) {
    const res = await this._fetch(this._url(path), {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
    })
    return res
  }

  // ── ANNOUNCE / RESOLVE ──────────────────────────────────────────────────────

  /**
   * Announce this identity's presence (signed, TTL'd). endpoints are OPAQUE hints
   * the relay stores and echoes but never dials.
   * @param {object} [opts]
   * @param {string[]} [opts.endpoints] - connection hints (URLs / multiaddrs)
   * @param {string}   [opts.meta]      - opaque app-defined blob (≤2 KiB)
   * @param {number}   [opts.ttl]       - requested lifetime in seconds (clamped)
   * @returns {Promise<{ok:boolean, key:string, ttl:number, expires_at:number}>}
   */
  async announce({ endpoints = [], meta = '', ttl = 0 } = {}) {
    const req = {
      key: this.key,
      endpoints,
      meta,
      ttl,
      nonce: randomNonce(),
      ts: nowUnix(),
    }
    const fields = [req.key, String(req.ts), String(req.ttl), req.nonce, req.meta, ...endpoints]
    req.sig = this.identity.sign(canonicalMessage(DOMAIN.announce, fields))
    const res = await this._postJSON('/announce', req)
    return this._json(res, 'announce')
  }

  /** Withdraw this identity's presence record (signed). */
  async withdraw() {
    const req = { key: this.key, nonce: randomNonce(), ts: nowUnix() }
    req.sig = this.identity.sign(canonicalMessage(DOMAIN.withdraw, [req.key, String(req.ts), req.nonce]))
    const res = await this._postJSON('/withdraw', req)
    return this._json(res, 'withdraw')
  }

  /**
   * Resolve a key to its current presence. Unauthenticated read.
   * @param {string} key - base64url Ed25519 public key
   * @returns {Promise<{key:string, online:boolean, endpoints?:string[], meta?:string, expires_at?:number}>}
   */
  async resolve(key) {
    const res = await this._fetch(this._url('/resolve/' + encodeURIComponent(key)), {
      method: 'GET',
      headers: this._authToken ? { Authorization: `Bearer ${this._authToken}` } : {},
    })
    if (res.status === 404) {
      const body = await res.json().catch(() => ({}))
      return { key, online: false, ...body }
    }
    return this._json(res, 'resolve')
  }

  // ── SIGNAL (short-TTL WebRTC offer/answer/ICE) ───────────────────────────────

  /** Deposit an opaque WebRTC signal blob addressed to recipientKey. */
  signalDeposit(recipientKey, payload, ttl = 0) {
    return this._deposit(DOMAIN.signalDeposit, '/signal/', recipientKey, payload, ttl)
  }

  /** Long-poll this identity's signal inbox. Returns an array of {id, from, payload(bytes), ts, exp}. */
  signalPoll({ wait = 0 } = {}) {
    return this._poll(DOMAIN.signalPoll, '/signal/', wait)
  }

  /** Ack (delete) consumed signal blobs by id. */
  signalAck(ids) {
    return this._ack(DOMAIN.signalAck, '/signal/', ids)
  }

  // ── MAILBOX (longer-TTL opaque encrypted blobs) ──────────────────────────────

  /** Deposit an opaque encrypted blob into recipientKey's mailbox. */
  mailboxDeposit(recipientKey, payload, ttl = 0) {
    return this._deposit(DOMAIN.mailboxDeposit, '/mailbox/', recipientKey, payload, ttl)
  }

  /** Long-poll this identity's mailbox. */
  mailboxPoll({ wait = 0 } = {}) {
    return this._poll(DOMAIN.mailboxPoll, '/mailbox/', wait)
  }

  /** Ack (delete) consumed mailbox blobs by id. */
  mailboxAck(ids) {
    return this._ack(DOMAIN.mailboxAck, '/mailbox/', ids)
  }

  // ── ICE ──────────────────────────────────────────────────────────────────────

  /**
   * Fetch the relay's ICE server list (STUN + ephemeral-cred TURN). The optional
   * key hint is folded into the TURN username (non-authenticating bookkeeping).
   * @returns {Promise<Array<{urls:string[], username?:string, credential?:string, ttl?:number}>>}
   */
  async ice() {
    const q = this.key ? '?key=' + encodeURIComponent(this.key) : ''
    const res = await this._fetch(this._url('/ice' + q), {
      method: 'GET',
      headers: this._authToken ? { Authorization: `Bearer ${this._authToken}` } : {},
    })
    const body = await this._json(res, 'ice')
    return body.ice_servers || []
  }

  /** The ICE URL (for handing to FabricClient's iceUrl option). */
  iceUrl() {
    return this._url('/ice')
  }

  // ── shared internals ─────────────────────────────────────────────────────────

  async _deposit(domain, pathBase, recipientKey, payload, ttl) {
    // ArrayBuffer.isView() is realm-agnostic (unlike `instanceof Uint8Array`,
    // which fails for a Uint8Array minted in a different realm, e.g. a TextEncoder
    // output under jsdom) — so byte payloads are always base64url-encoded, and
    // only genuine strings are passed through as pre-encoded base64url.
    const payloadB64 = ArrayBuffer.isView(payload) ? b64urlEncode(payload) : String(payload)
    const req = {
      from: this.key,
      to: recipientKey,
      payload: payloadB64,
      ttl: ttl | 0,
      nonce: randomNonce(),
      ts: nowUnix(),
    }
    const fields = [req.from, req.to, String(req.ts), String(req.ttl), req.nonce, req.payload]
    req.sig = this.identity.sign(canonicalMessage(domain, fields))
    const res = await this._postJSON(pathBase + encodeURIComponent(recipientKey), req)
    return this._json(res, 'deposit')
  }

  async _poll(domain, pathBase, wait) {
    const req = { key: this.key, nonce: randomNonce(), ts: nowUnix(), wait: wait | 0 }
    req.sig = this.identity.sign(canonicalMessage(domain, [req.key, String(req.ts), req.nonce]))
    const res = await this._postJSON(pathBase + encodeURIComponent(this.key) + '/poll', req)
    const body = await this._json(res, 'poll')
    const blobs = (body.blobs || []).map((b) => ({
      id: b.id,
      from: b.from,
      payload: b64urlDecode(b.payload), // decoded opaque bytes
      payloadB64: b.payload,
      ts: b.ts,
      exp: b.exp,
    }))
    return blobs
  }

  async _ack(domain, pathBase, ids) {
    const list = Array.isArray(ids) ? ids : [ids]
    if (list.length === 0) return { deleted: 0 }
    const req = { key: this.key, ids: list, nonce: randomNonce(), ts: nowUnix() }
    req.sig = this.identity.sign(canonicalMessage(domain, [req.key, String(req.ts), req.nonce, ...list]))
    const res = await this._postJSON(pathBase + encodeURIComponent(this.key) + '/ack', req)
    return this._json(res, 'ack')
  }

  async _json(res, op) {
    if (!res.ok) {
      let reason = res.statusText || 'error'
      try {
        const b = await res.json()
        if (b && b.error) reason = b.error
      } catch { /* non-JSON body */ }
      throw new RelayDepositError(`rendezvous ${op} failed: ${res.status} ${reason}`, {
        code: 'RENDEZVOUS_' + op.toUpperCase(),
        status: res.status,
      })
    }
    return res.json()
  }
}

export { DOMAIN as RENDEZVOUS_DOMAINS }
