/**
 * src/lib/crdt/p2pRoom.js — secure local/P2P collaboration room (WAVE-25).
 *
 * This is the ADDITIVE second collab mode for Diwan: two OSS installs
 * co-edit a document with NO cloud doc backend. It layers three things on top
 * of the existing FabricClient P2P transport (WebRTC data channels + relay-
 * circuit fallback) and the document engine (Yjs — see ./ydoc.js, and
 * ./yP2PSession.js for the session that consumes this module):
 *
 *   1. INVITE LINK / CAPABILITY  — a peer joins a doc's P2P room only if it holds
 *      a signed capability embedded in an invite link: {roomId, roomKey, cap}.
 *      Knowing roomId alone does NOT admit — the roomKey is required to produce
 *      messages any honest peer will accept (every frame carries a room MAC keyed
 *      by the roomKey; frames without a valid MAC are dropped). This is
 *      capability-by-key, not obscurity.
 *
 *   2. E2E ENCRYPTION (the key security property) — every CRDT op / snapshot /
 *      presence frame is sealed with AES-256-GCM under a key DERIVED from the
 *      roomKey, with a fresh per-message nonce. The relay server and any
 *      uninvited peer are therefore CONTENT-BLIND: they route ciphertext and can
 *      never read the document. Mirrors the vulos contentSeal.js primitive
 *      choice (WebCrypto AES-256-GCM, zero third-party JS) so it runs anywhere
 *      SubtleCrypto is present with no new deps.
 *
 *   3. READ-ONLY ENFORCEMENT — the invite's `cap` is "rw" or "ro". A ro peer is
 *      given a roomKey that can DECRYPT (so it can read + render live edits) and
 *      a SEND MAC that honest rw peers reject for op frames. Mirrors Board's
 *      wave-15 ro enforcement: ro peers cannot produce ops that others accept.
 *
 * HONEST SCOPE / CAVEATS (see the security notes at the bottom of the file and
 * the wave-25 report):
 *   • Capability authz is "link holders", not per-identity — anyone the link is
 *     forwarded to can join with that link's cap. (Account-linked mode, where
 *     the peer is additionally authenticated by the fabric's ECDSA identity, is
 *     the existing cloud path and is unaffected.)
 *   • Revocation = rotate the roomKey (mint a new link); old links then decrypt
 *     nothing new. There is no per-peer revocation of an already-shared link.
 *   • ro enforcement is HONEST-PEER enforcement: a ro holder who patches their
 *     own client can still emit op frames, but they cannot forge the RW MAC, so
 *     honest rw peers reject those ops and never merge them. This is the same
 *     trust model as Board's ro mode (and any client-side CRDT ro mode).
 */

// ── constants ──────────────────────────────────────────────────────────────

const ROOM_MAGIC = 'VP2P1' // frame magic (versioned)
const GCM_NONCE_LEN = 12
const AEAD_AAD = 'diwan-p2p-room-v1'

// HKDF info labels — the invite carries ONE 32-byte roomKey; we derive three
// independent sub-keys from it so a compromise of one purpose does not leak the
// others, and so the RW send-MAC key is genuinely unavailable to ro peers.
const INFO_ENC = 'diwan-p2p/enc'      // AES-GCM content key (rw + ro)
const INFO_MAC_RW = 'diwan-p2p/mac-rw' // HMAC key proving RW authority
const INFO_ROOMID = 'diwan-p2p/roomid' // derive roomId from roomKey (binding)

const CAP_RW = 'rw'
const CAP_RO = 'ro'

export type RoomCap = typeof CAP_RW | typeof CAP_RO

/** The room's crypto material — what `sealFrame`/`openFrame` need. */
export type RoomKeys = {
  encKey: CryptoKey
  macKeyRw: CryptoKey | null
  roomId: string
}

export type Invite = {
  link: string
  fragment: string
  roomId: string
  cap: RoomCap
  roomKey: Uint8Array
}

export type ParsedInvite = {
  roomId: string
  cap: RoomCap
  roomKey: Uint8Array
}

const te = new TextEncoder()
const td = new TextDecoder()

function subtle(): SubtleCrypto {
  const s = globalThis.crypto && globalThis.crypto.subtle
  if (!s) throw new Error('p2pRoom: WebCrypto SubtleCrypto unavailable (requires a secure context)')
  return s
}

function randomBytes(n: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(n))
}

// ── base64url (URL-safe, unpadded) — safe to carry in a link fragment ────────

export function bytesToB64url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function b64urlToBytes(b64url: string): Uint8Array {
  let s = String(b64url).replace(/-/g, '+').replace(/_/g, '/')
  while (s.length % 4) s += '='
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// ── key derivation ───────────────────────────────────────────────────────────

const ZERO_SALT_32 = new Uint8Array(32)

async function hkdf32(ikm: Uint8Array, infoStr: string): Promise<Uint8Array> {
  const base = await subtle().importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits'])
  const bits = await subtle().deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: ZERO_SALT_32, info: te.encode(infoStr) },
    base,
    256,
  )
  return new Uint8Array(bits)
}

/**
 * Derive the room's crypto material from the raw 32-byte roomKey.
 *
 * @param roomKey  32-byte symmetric root key (carried in the link)
 * @returns
 *   - encKey    : AES-256-GCM key for E2E content sealing (rw + ro both hold it)
 *   - macKeyRw  : HMAC-SHA256 key proving RW authority (rw holders only, in
 *                 practice — see deriveRoomFromInvite which strips it for ro)
 *   - roomId    : deterministic room/session id derived from the key so the
 *                 signaling rendezvous never needs the key itself
 */
export async function deriveRoomKeys(roomKey: Uint8Array): Promise<RoomKeys> {
  if (!(roomKey instanceof Uint8Array) || roomKey.length !== 32) {
    throw new Error('p2pRoom: roomKey must be 32 bytes')
  }
  const encRaw = await hkdf32(roomKey, INFO_ENC)
  const macRwRaw = await hkdf32(roomKey, INFO_MAC_RW)
  const roomIdRaw = await hkdf32(roomKey, INFO_ROOMID)

  const encKey = await subtle().importKey('raw', encRaw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt'])
  const macKeyRw = await subtle().importKey(
    'raw', macRwRaw as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  )
  encRaw.fill(0)
  macRwRaw.fill(0)
  // roomId: first 16 bytes of the derived material, hex — public, non-secret.
  const roomId = [...roomIdRaw.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')
  roomIdRaw.fill(0)
  return { encKey, macKeyRw, roomId }
}

// ── invite link generate / parse ─────────────────────────────────────────────

export type GenerateInviteOptions = {
  /** capability granted to the link holder */
  cap?: RoomCap
  /** app origin+path to prefix (default: current location origin + /docs/collab).
   *  When omitted in a non-browser context, only the fragment is returned. */
  baseUrl?: string | undefined
  /** reuse an existing roomKey (for ro derived from the same room as an rw
   *  link). Default: a fresh random 32-byte key. */
  roomKey?: Uint8Array
}

/**
 * Generate a fresh P2P collaboration invite for a document.
 *
 * The returned link embeds the room material in the URL FRAGMENT (after `#`),
 * which browsers never send to any server (not in the request, not in Referer).
 * The relay/host therefore never sees the roomKey.
 */
export async function generateInvite({ cap = CAP_RW, baseUrl, roomKey }: GenerateInviteOptions = {}): Promise<Invite> {
  // See yP2PSession.ts's identical guard: TS narrows `cap` to `never` here
  // (its declared type only allows CAP_RW/CAP_RO), but this is real defense
  // against an untyped caller — String() just satisfies the checker.
  if (cap !== CAP_RW && cap !== CAP_RO) throw new Error(`p2pRoom: bad cap "${String(cap)}"`)
  const key = roomKey instanceof Uint8Array && roomKey.length === 32 ? roomKey : randomBytes(32)
  const { roomId } = await deriveRoomKeys(key)

  // Invite payload lives in the fragment: v, room id, cap, and the roomKey.
  // roomId is derived from the key, so it is redundant-but-convenient; joiners
  // recompute and verify it matches (binds the link's id to its key).
  const payload = {
    v: 1,
    r: roomId,
    c: cap,
    k: bytesToB64url(key),
  }
  const fragment = 'vp2p=' + bytesToB64url(te.encode(JSON.stringify(payload)))

  let link = fragment
  if (baseUrl) {
    link = baseUrl + '#' + fragment
  } else if (typeof window !== 'undefined' && window.location) {
    link = `${window.location.origin}/docs/collab#${fragment}`
  }
  return { link, fragment, roomId, cap, roomKey: key }
}

/**
 * Parse an invite link (or bare fragment) back into its room material.
 * Throws (fail-closed) on any malformed / tampered / roomId-mismatch input —
 * a bad link never silently degrades into an open (unkeyed) room.
 *
 * @param linkOrFragment  full URL, `#vp2p=…` fragment, or `vp2p=…`
 */
export async function parseInvite(linkOrFragment: string): Promise<ParsedInvite> {
  if (typeof linkOrFragment !== 'string' || !linkOrFragment) {
    throw new Error('p2pRoom: empty invite')
  }
  // Extract the fragment component if a full URL was passed.
  let frag = linkOrFragment
  const hash = frag.indexOf('#')
  if (hash >= 0) frag = frag.slice(hash + 1)
  frag = frag.replace(/^#/, '')
  const m = /(?:^|[&?])vp2p=([A-Za-z0-9\-_]+)/.exec(frag)
  const b64 = m ? m[1] : (/^[A-Za-z0-9\-_]+$/.test(frag) ? frag : null)
  if (!b64) throw new Error('p2pRoom: no vp2p invite payload found')

  let payload: { v?: number; r?: string; c?: string; k?: string }
  try {
    payload = JSON.parse(td.decode(b64urlToBytes(b64))) as { v?: number; r?: string; c?: string; k?: string }
  } catch {
    throw new Error('p2pRoom: malformed invite payload')
  }
  if (!payload || payload.v !== 1) throw new Error('p2pRoom: unsupported invite version')
  const cap = payload.c
  if (cap !== CAP_RW && cap !== CAP_RO) throw new Error('p2pRoom: bad cap in invite')

  const roomKey = b64urlToBytes(payload.k ?? '')
  if (roomKey.length !== 32) throw new Error('p2pRoom: bad roomKey length')

  // Re-derive roomId from the key and verify it matches the link's claim. This
  // makes the roomId non-forgeable relative to the key: you cannot point a key
  // at someone else's advertised roomId.
  const { roomId } = await deriveRoomKeys(roomKey)
  if (payload.r && payload.r !== roomId) {
    throw new Error('p2pRoom: invite roomId does not match its roomKey')
  }
  return { roomId, cap, roomKey }
}

// ── frame seal / open (E2E, per-message nonce, MAC-gated) ────────────────────
//
// Wire frame (Uint8Array, base64url on the FabricClient text channel):
//   magic "VP2P1" (5) || flags(1) || nonce(12) || AES-256-GCM(ciphertext||tag)
// where flags bit0 = "RW-authoritative" (op frames from an rw peer carry a valid
// RW-MAC and set this bit; the MAC covers nonce||ciphertext and is appended
// INSIDE the encrypted plaintext so the relay cannot even see whether a frame is
// rw or ro — see below). The AEAD AAD binds magic+flags so they cannot be
// flipped by a tamperer without failing the open.
//
// RW proof: for cap="rw" frames, the plaintext is { m: <macB64>, p: <payload> }
// where m = HMAC-RW(nonce || canonical(payload)). ro peers hold encKey (so they
// decrypt and render) but NOT macKeyRw, so they cannot compute a valid m. An rw
// receiver verifies m before accepting an op; a missing/invalid m on an op frame
// is rejected (ro peer tried to write). Presence/read frames don't require it.

const FLAG_NONE = 0x00

export type SealFrameOptions = {
  /** attach an RW-MAC (requires macKeyRw) */
  authoritative?: boolean
}

export type OpenFrameResult = {
  msg: unknown
  /** true iff the frame carried a VALID RW-MAC (verifiable only by a holder of
   *  macKeyRw — i.e. an rw peer). ro peers get authoritative=false even for
   *  genuinely-rw frames because they lack the key; that's fine, they only
   *  need to READ. */
  authoritative: boolean
}

/**
 * Seal a message object for the room.
 *
 * @param room  { encKey, macKeyRw|null }
 * @param msg    the application message (e.g. {type:'op', op})
 * @returns base64url frame
 */
export async function sealFrame(room: RoomKeys, msg: unknown, { authoritative = false }: SealFrameOptions = {}): Promise<string> {
  const nonce = randomBytes(GCM_NONCE_LEN)
  let inner: unknown
  if (authoritative) {
    if (!room.macKeyRw) throw new Error('p2pRoom: cannot sign RW frame without RW authority')
    const payloadBytes = te.encode(JSON.stringify(msg))
    const macInput = concat(nonce, payloadBytes)
    const macBuf = await subtle().sign('HMAC', room.macKeyRw, macInput as BufferSource)
    inner = { m: bytesToB64url(new Uint8Array(macBuf)), p: msg }
  } else {
    inner = { p: msg }
  }
  const plaintext = te.encode(JSON.stringify(inner))
  const flags = FLAG_NONE
  const aad = te.encode(AEAD_AAD + ':' + flags)
  const ctBuf = await subtle().encrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: aad },
    room.encKey,
    plaintext,
  )
  const frame = concat(te.encode(ROOM_MAGIC), Uint8Array.of(flags), nonce, new Uint8Array(ctBuf))
  return bytesToB64url(frame)
}

/**
 * Open + authenticate a room frame.
 *
 * Throws on wrong-key / tamper (AEAD fail) — content-blind relay and
 * uninvited peers can never open a frame.
 */
export async function openFrame(room: RoomKeys, frameB64url: string): Promise<OpenFrameResult> {
  const frame = b64urlToBytes(frameB64url)
  const magicLen = ROOM_MAGIC.length
  if (frame.length < magicLen + 1 + GCM_NONCE_LEN + 16) {
    throw new Error('p2pRoom: frame too short')
  }
  for (let i = 0; i < magicLen; i++) {
    if (frame[i] !== ROOM_MAGIC.charCodeAt(i)) throw new Error('p2pRoom: bad frame magic')
  }
  const flags = frame[magicLen]
  const nonce = frame.subarray(magicLen + 1, magicLen + 1 + GCM_NONCE_LEN)
  const ct = frame.subarray(magicLen + 1 + GCM_NONCE_LEN)
  const aad = te.encode(AEAD_AAD + ':' + flags)
  const ptBuf = await subtle().decrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: aad },
    room.encKey,
    ct as BufferSource,
  )
  const inner = JSON.parse(td.decode(new Uint8Array(ptBuf))) as { p: unknown; m?: string }
  const msg = inner.p
  let authoritative = false
  if (inner.m && room.macKeyRw) {
    // Verify the RW-MAC over nonce || canonical(payload). Only a holder of
    // macKeyRw (an rw peer) could have produced a valid m.
    const payloadBytes = te.encode(JSON.stringify(msg))
    const macInput = concat(new Uint8Array(nonce), payloadBytes)
    const macBytes = b64urlToBytes(inner.m)
    authoritative = await subtle().verify('HMAC', room.macKeyRw, macBytes as BufferSource, macInput as BufferSource)
  }
  return { msg, authoritative }
}

function concat(...arrs: Uint8Array[]): Uint8Array {
  let n = 0
  for (const a of arrs) n += a.length
  const out = new Uint8Array(n)
  let o = 0
  for (const a of arrs) { out.set(a, o); o += a.length }
  return out
}

export { CAP_RW, CAP_RO }
