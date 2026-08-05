// no-broker-dep:allow-file: this is the reference client for the OPEN rendezvous role
// (implemented by any conforming vulos-relayd, or by Diwan's OWN backend/rendezvous — the
// default path). It is a protocol client the app calls at a URL the operator supplies; there
// is no default endpoint (RendezvousURL defaults empty, verified by
// backend/config/config_test.go's TestDefault_RendezvousURLEmpty).
//
// rendezvous.ts — the reference JS client for the OPEN rendezvous role served by
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
} as const

// ── base64url (unpadded) — the single binary encoding on the wire ─────────────

/** Encode bytes to unpadded base64url. */
export function b64urlEncode(bytes: Uint8Array | ArrayBufferLike): string {
  let bin = ''
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]!)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Decode unpadded base64url to bytes. */
export function b64urlDecode(str: string): Uint8Array {
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
export function canonicalMessage(domain: string, fields: Array<string | number>): Uint8Array {
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
  secretKey: Uint8Array
  publicKey: Uint8Array
  /** canonical base64url public key — the address of this identity */
  key: string

  /** @param secretKey - 32-byte Ed25519 seed/secret */
  constructor(secretKey: Uint8Array | ArrayBufferLike) {
    this.secretKey = secretKey instanceof Uint8Array ? secretKey : new Uint8Array(secretKey)
    this.publicKey = ed25519.getPublicKey(this.secretKey)
    this.key = b64urlEncode(this.publicKey)
  }

  static generate(): RendezvousIdentity {
    return new RendezvousIdentity(ed25519.utils.randomSecretKey())
  }

  /** Sign a canonical message; returns the signature as base64url. */
  sign(msg: Uint8Array): string {
    return b64urlEncode(ed25519.sign(msg, this.secretKey))
  }
}

/** Fresh random nonce (base64url of 16 bytes) for replay protection. */
export function randomNonce(): string {
  const b = new Uint8Array(16)
  globalThis.crypto.getRandomValues(b)
  return b64urlEncode(b)
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000)
}

// ── wire response shapes ────────────────────────────────────────────────────

/** The minimal `fetch`-shaped response this client depends on. */
export interface RendezvousFetchResponse {
  ok: boolean
  status: number
  statusText?: string
  json(): Promise<unknown>
}

/** An injectable fetch, matching the subset of `fetch` this client calls. */
export type RendezvousFetch = (url: string, init?: RequestInit) => Promise<RendezvousFetchResponse>

export interface AnnounceResult {
  ok: boolean
  key: string
  ttl: number
  expires_at: number
}

export interface ResolveResult {
  key: string
  online: boolean
  endpoints?: string[]
  meta?: string
  expires_at?: number
}

export interface DepositResult {
  ok: boolean
  id: string
  expires_at: number
}

/** One decoded blob from a signal/mailbox poll — the opaque `payload` bytes are pre-decoded. */
export interface PolledBlob {
  id: string
  from: string
  /** decoded opaque bytes */
  payload: Uint8Array
  payloadB64: string
  ts: number
  exp: number
}

export interface AckResult {
  deleted: number
}

export interface IceServer {
  urls: string[]
  username?: string
  credential?: string
  ttl?: number
}

/** Wire shape of one poll-response blob, before payload decoding. */
interface RawPolledBlob {
  id: string
  from: string
  payload: string
  ts: number
  exp: number
}

// ── client ──────────────────────────────────────────────────────────────────

/** Constructor options for {@link RendezvousClient}. */
export interface RendezvousClientOptions {
  /** relay origin, e.g. "https://relay.example.com" */
  baseUrl: string
  /** this peer's Ed25519 identity */
  identity: RendezvousIdentity
  /** mount prefix (default "/rendezvous") */
  prefix?: string
  /**
   * optional Bearer token for the relay's own gate (the rendezvous protocol
   * itself is signature-authenticated; a token is only for a paid/gated
   * relay's edge). Refused on an insecure (plaintext non-loopback) baseUrl.
   */
  authToken?: string | null | undefined
  /** injectable fetch (tests) */
  fetch?: RendezvousFetch
}

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
  baseUrl: string
  prefix: string
  identity: RendezvousIdentity
  key: string
  private _authToken: string | null | undefined
  private _fetch: RendezvousFetch

  constructor({ baseUrl, identity, prefix = '/rendezvous', authToken = null, fetch: fetchImpl }: RendezvousClientOptions) {
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
    this._fetch = fetchImpl || ((url: string, init?: RequestInit) => globalThis.fetch(url, init))
  }

  /**
   * Return a new RendezvousClient that talks to the SAME relay (base URL, mount
   * prefix, auth token, fetch impl) under a DIFFERENT Ed25519 identity. Used by
   * the rendezvous signaling transport to hold both a per-peer "self" client and
   * a session-derived "room" client (whose private key every session member can
   * derive) against one relay without re-plumbing the transport config.
   */
  withIdentity(identity: RendezvousIdentity): RendezvousClient {
    return new RendezvousClient({
      baseUrl: this.baseUrl,
      identity,
      prefix: this.prefix,
      authToken: this._authToken,
      fetch: this._fetch,
    })
  }

  private _url(path: string): string {
    return this.baseUrl + this.prefix + path
  }

  private _headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this._authToken) h.Authorization = `Bearer ${this._authToken}`
    return h
  }

  private async _postJSON(path: string, body: unknown): Promise<RendezvousFetchResponse> {
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
   * @param opts.endpoints - connection hints (URLs / multiaddrs)
   * @param opts.meta      - opaque app-defined blob (≤2 KiB)
   * @param opts.ttl       - requested lifetime in seconds (clamped)
   */
  async announce({ endpoints = [], meta = '', ttl = 0 }: { endpoints?: string[], meta?: string, ttl?: number } = {}): Promise<AnnounceResult> {
    const req: {
      key: string, endpoints: string[], meta: string, ttl: number, nonce: string, ts: number, sig?: string
    } = {
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
    return this._json<AnnounceResult>(res, 'announce')
  }

  /** Withdraw this identity's presence record (signed). */
  async withdraw(): Promise<{ ok: boolean }> {
    const req: { key: string, nonce: string, ts: number, sig?: string } = { key: this.key, nonce: randomNonce(), ts: nowUnix() }
    req.sig = this.identity.sign(canonicalMessage(DOMAIN.withdraw, [req.key, String(req.ts), req.nonce]))
    const res = await this._postJSON('/withdraw', req)
    return this._json<{ ok: boolean }>(res, 'withdraw')
  }

  /**
   * Resolve a key to its current presence. Unauthenticated read.
   * @param key - base64url Ed25519 public key
   */
  async resolve(key: string): Promise<ResolveResult> {
    const res = await this._fetch(this._url('/resolve/' + encodeURIComponent(key)), {
      method: 'GET',
      headers: this._authToken ? { Authorization: `Bearer ${this._authToken}` } : {},
    })
    if (res.status === 404) {
      const body = (await res.json().catch(() => ({}))) as Partial<ResolveResult>
      return { key, online: false, ...body }
    }
    return this._json<ResolveResult>(res, 'resolve')
  }

  // ── SIGNAL (short-TTL WebRTC offer/answer/ICE) ───────────────────────────────

  /** Deposit an opaque WebRTC signal blob addressed to recipientKey. */
  signalDeposit(recipientKey: string, payload: Uint8Array | string, ttl = 0): Promise<DepositResult> {
    return this._deposit(DOMAIN.signalDeposit, '/signal/', recipientKey, payload, ttl)
  }

  /** Long-poll this identity's signal inbox. Returns an array of {id, from, payload(bytes), ts, exp}. */
  signalPoll({ wait = 0 }: { wait?: number } = {}): Promise<PolledBlob[]> {
    return this._poll(DOMAIN.signalPoll, '/signal/', wait)
  }

  /** Ack (delete) consumed signal blobs by id. */
  signalAck(ids: string | string[]): Promise<AckResult> {
    return this._ack(DOMAIN.signalAck, '/signal/', ids)
  }

  // ── MAILBOX (longer-TTL opaque encrypted blobs) ──────────────────────────────

  /** Deposit an opaque encrypted blob into recipientKey's mailbox. */
  mailboxDeposit(recipientKey: string, payload: Uint8Array | string, ttl = 0): Promise<DepositResult> {
    return this._deposit(DOMAIN.mailboxDeposit, '/mailbox/', recipientKey, payload, ttl)
  }

  /** Long-poll this identity's mailbox. */
  mailboxPoll({ wait = 0 }: { wait?: number } = {}): Promise<PolledBlob[]> {
    return this._poll(DOMAIN.mailboxPoll, '/mailbox/', wait)
  }

  /** Ack (delete) consumed mailbox blobs by id. */
  mailboxAck(ids: string | string[]): Promise<AckResult> {
    return this._ack(DOMAIN.mailboxAck, '/mailbox/', ids)
  }

  // ── ICE ──────────────────────────────────────────────────────────────────────

  /**
   * Fetch the relay's ICE server list (STUN + ephemeral-cred TURN). The optional
   * key hint is folded into the TURN username (non-authenticating bookkeeping).
   */
  async ice(): Promise<IceServer[]> {
    const q = this.key ? '?key=' + encodeURIComponent(this.key) : ''
    const res = await this._fetch(this._url('/ice' + q), {
      method: 'GET',
      headers: this._authToken ? { Authorization: `Bearer ${this._authToken}` } : {},
    })
    const body = await this._json<{ ice_servers?: IceServer[] }>(res, 'ice')
    return body.ice_servers || []
  }

  /** The ICE URL (for handing to FabricClient's iceUrl option). */
  iceUrl(): string {
    return this._url('/ice')
  }

  // ── shared internals ─────────────────────────────────────────────────────────

  private async _deposit(
    domain: string,
    pathBase: string,
    recipientKey: string,
    payload: Uint8Array | string,
    ttl: number,
  ): Promise<DepositResult> {
    // ArrayBuffer.isView() is realm-agnostic (unlike `instanceof Uint8Array`,
    // which fails for a Uint8Array minted in a different realm, e.g. a TextEncoder
    // output under jsdom) — so byte payloads are always base64url-encoded, and
    // only genuine strings are passed through as pre-encoded base64url.
    const payloadB64 = ArrayBuffer.isView(payload) ? b64urlEncode(payload) : String(payload)
    const req: {
      from: string, to: string, payload: string, ttl: number, nonce: string, ts: number, sig?: string
    } = {
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
    return this._json<DepositResult>(res, 'deposit')
  }

  private async _poll(domain: string, pathBase: string, wait: number): Promise<PolledBlob[]> {
    const req: { key: string, nonce: string, ts: number, wait: number, sig?: string } = {
      key: this.key, nonce: randomNonce(), ts: nowUnix(), wait: wait | 0,
    }
    req.sig = this.identity.sign(canonicalMessage(domain, [req.key, String(req.ts), req.nonce]))
    const res = await this._postJSON(pathBase + encodeURIComponent(this.key) + '/poll', req)
    const body = await this._json<{ blobs?: RawPolledBlob[] }>(res, 'poll')
    const blobs: PolledBlob[] = (body.blobs || []).map((b) => ({
      id: b.id,
      from: b.from,
      payload: b64urlDecode(b.payload), // decoded opaque bytes
      payloadB64: b.payload,
      ts: b.ts,
      exp: b.exp,
    }))
    return blobs
  }

  private async _ack(domain: string, pathBase: string, ids: string | string[]): Promise<AckResult> {
    const list = Array.isArray(ids) ? ids : [ids]
    if (list.length === 0) return { deleted: 0 }
    const req: { key: string, ids: string[], nonce: string, ts: number, sig?: string } = {
      key: this.key, ids: list, nonce: randomNonce(), ts: nowUnix(),
    }
    req.sig = this.identity.sign(canonicalMessage(domain, [req.key, String(req.ts), req.nonce, ...list]))
    const res = await this._postJSON(pathBase + encodeURIComponent(this.key) + '/ack', req)
    return this._json<AckResult>(res, 'ack')
  }

  private async _json<T>(res: RendezvousFetchResponse, op: string): Promise<T> {
    if (!res.ok) {
      let reason: unknown = res.statusText || 'error'
      try {
        const b = (await res.json()) as { error?: unknown } | null
        if (b && b.error) reason = b.error
      } catch { /* non-JSON body */ }
      throw new RelayDepositError(`rendezvous ${op} failed: ${res.status} ${reason}`, {
        code: 'RENDEZVOUS_' + op.toUpperCase(),
        status: res.status,
      })
    }
    return res.json() as Promise<T>
  }
}

export { DOMAIN as RENDEZVOUS_DOMAINS }
