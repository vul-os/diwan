/**
 * relayBox.ts — end-to-end confidentiality for the relay-fallback path.
 *
 * When the WebRTC P2P data channel cannot be established, FabricClient falls
 * back to depositing application payloads (live Office doc edits, cursors) on
 * the relay server for the peer to pick up.  The relay server is an
 * UNTRUSTED transport: the product markets this path as sovereign / E2E, so the
 * relay MUST NOT be able to read the relayed collaboration content.
 *
 * Previously the deposit payload was `btoa(JSON.stringify({session, data}))` —
 * base64 PLAINTEXT — so the relay/host saw everything.  The ECDSA deposit
 * signature provided authenticity but NOT confidentiality.
 *
 * This module adds confidentiality using the same scheme the OS relay path
 * uses: XChaCha20-Poly1305 AEAD keyed by an X25519 ECDH shared secret.  The
 * AEAD seal is layered UNDER the existing ECDSA signature, so authenticity is
 * unchanged — we only add a confidentiality envelope the relay cannot open.
 *
 * Key model:
 *   • Each peer holds a per-session X25519 box keypair (separate from the ECDSA
 *     signing identity — WebCrypto will not reuse a sign/verify key for ECDH).
 *   • The box PUBLIC key is published in the signaling "join" frame
 *     (`boxPubKey`), bound to the authenticated peerId by the server's JWT auth,
 *     and stored TOFU by the receiver — exactly mirroring how `depositPubKey`
 *     is already exchanged.
 *   • The sender's box public key also travels inside each deposit blob (`epk`)
 *     and is covered by the ECDSA signature, so it is authenticated end-to-end.
 *
 * Wire format (the bytes that become `blob_b64`):
 *   version(1) || nonce(24) || XChaCha20Poly1305_seal
 * where the AEAD additional-authenticated-data binds the ciphertext to the
 * sender, recipient and session: AAD = utf8(`${from}|${to}|${session}`).
 *
 * Pure JS, no native deps (matches the fabric.js "no CGO" constraint) — uses
 * the audited @noble/* primitives.
 *
 * NOTE (interop): the OS `relay.go` cross-instance path uses the same AEAD
 * (XChaCha20-Poly1305 from X25519-ECDH) but signs with Ed25519, whereas this
 * browser fabric path signs with ECDSA P-256 and frames the blob as above.
 * The two relay-blob wire formats are therefore NOT byte-compatible — but they
 * never interoperate directly: this path is browser-peer ⇄ browser-peer (both
 * run this code), while relay.go is OS-instance ⇄ OS-instance.  See the relay
 * deposit summary for the full note.
 */

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'

const BOX_VERSION = 0x01             // v1: static-static X25519 ECDH (NO forward secrecy)
const BOX_VERSION_V2 = 0x02          // v2: X3DH forward-secret content key (see prekeys.ts)
const NONCE_LEN = 24                 // XChaCha20-Poly1305 nonce
const HKDF_INFO = new TextEncoder().encode('vulos-relay-box-v1')

// ── base64 helpers (browser + Node) ──────────────────────────────────────────

export function bytesToB64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  return btoa(s)
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// ── X25519 box keypair ───────────────────────────────────────────────────────

/** A fresh X25519 box keypair, as returned by {@link generateBoxKeyPair}. */
export interface BoxKeyPair {
  privateKey: Uint8Array
  publicKey: Uint8Array
  publicKeyB64: string
}

// @noble/curves 2.x exposes randomSecretKey(); fall back to the older name for
// any older/newer copy on the resolution path that still exposes it under that
// name (not present in the installed version's own .d.ts, hence the cast).
type X25519UtilsCompat = { randomSecretKey?: () => Uint8Array, randomPrivateKey?: () => Uint8Array }

/** Generate a fresh X25519 box keypair. */
export function generateBoxKeyPair(): BoxKeyPair {
  const utils = x25519.utils as X25519UtilsCompat
  const privateKey = utils.randomSecretKey ? utils.randomSecretKey() : utils.randomPrivateKey!()
  const publicKey = x25519.getPublicKey(privateKey)
  return { privateKey, publicKey, publicKeyB64: bytesToB64(publicKey) }
}

/**
 * Derive the symmetric AEAD key from an X25519 ECDH shared secret.
 * @param myPriv      this peer's X25519 private key
 * @param theirPub    the counterparty's X25519 public key
 * @returns 32-byte key
 */
function deriveKey(myPriv: Uint8Array, theirPub: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(myPriv, theirPub)
  return hkdf(sha256, shared, undefined, HKDF_INFO, 32)
}

function aad(from: string, to: string, session: string): Uint8Array {
  return new TextEncoder().encode(`${from}|${to}|${session}`)
}

// ── seal / open ──────────────────────────────────────────────────────────────

/** Arguments to {@link sealRelayBlob}. */
export interface SealRelayBlobArgs {
  /** UTF-8/binary payload bytes */
  plaintext: Uint8Array
  /** sender X25519 private key */
  senderBoxPriv: Uint8Array
  /** recipient X25519 public key (base64) */
  recipientBoxPubB64: string
  from: string
  to: string
  session: string
}

/**
 * Encrypt `plaintextBytes` for `recipientBoxPubB64`.
 * @returns blob_b64  (version || nonce || ciphertext+tag), base64
 */
export function sealRelayBlob({ plaintext, senderBoxPriv, recipientBoxPubB64, from, to, session }: SealRelayBlobArgs): string {
  const recipientPub = b64ToBytes(recipientBoxPubB64)
  const key = deriveKey(senderBoxPriv, recipientPub)
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN))
  const sealed = xchacha20poly1305(key, nonce, aad(from, to, session)).encrypt(plaintext)

  const out = new Uint8Array(1 + NONCE_LEN + sealed.length)
  out[0] = BOX_VERSION
  out.set(nonce, 1)
  out.set(sealed, 1 + NONCE_LEN)
  return bytesToB64(out)
}

/** Arguments to {@link openRelayBlob}. */
export interface OpenRelayBlobArgs {
  /** the blob_b64 from the relay */
  blobB64: string
  /** this peer's X25519 private key */
  recipientBoxPriv: Uint8Array
  /** sender X25519 public key (base64, the blob `epk`) */
  senderBoxPubB64: string
  from: string
  to: string
  session: string
}

/**
 * Decrypt a blob produced by sealRelayBlob.
 * @returns plaintext bytes
 * @throws on version mismatch, truncation, wrong key or tamper (AEAD failure)
 */
export function openRelayBlob({ blobB64, recipientBoxPriv, senderBoxPubB64, from, to, session }: OpenRelayBlobArgs): Uint8Array {
  const raw = b64ToBytes(blobB64)
  if (raw.length < 1 + NONCE_LEN + 16) throw new Error('relay blob too short')
  if (raw[0] !== BOX_VERSION) throw new Error('unsupported relay blob version ' + raw[0])
  const nonce = raw.subarray(1, 1 + NONCE_LEN)
  const sealed = raw.subarray(1 + NONCE_LEN)
  const senderPub = b64ToBytes(senderBoxPubB64)
  const key = deriveKey(recipientBoxPriv, senderPub)
  return xchacha20poly1305(key, nonce, aad(from, to, session)).decrypt(sealed)
}

// ── v2: X3DH forward-secret seal / open ──────────────────────────────────────
//
// v2 keeps XChaCha20-Poly1305 + the {from|to|session} AAD binding but takes the
// 32-byte key from the X3DH handshake (prekeys.ts) instead of static-static
// ECDH.  The X3DH header (ephemeral pub + prekey ids) travels in the clear UNDER
// the AEAD: it is additionally bound into the AAD, so any tampering with the
// ephemeral key or prekey ids breaks decryption (and would already yield a wrong
// key).  No secrets are in the header.
//
// Wire layout (the bytes that become blob_b64):
//   version(1)=0x02 || headerLen(2, big-endian) || headerJSON || nonce(24)
//     || XChaCha20Poly1305_seal
// where headerJSON = JSON.stringify({ v:2, ek:<b64 ephemeral pub>, spk_id,
//   opk_id|null }) and
//   AAD = utf8(`${from}|${to}|${session}`) || headerBytes.

/**
 * The clear-text v2 X3DH header, as it deserializes off the wire — untrusted
 * until the `v`/`ek`/`spk_id` shape checks below pass, so its fields are typed
 * `unknown` rather than asserted (mirrors the original's lack of a validated
 * shape: `opk_id` in particular is passed through with NO type check, exactly
 * as the pre-conversion JS did).
 */
interface V2HeaderJSON {
  v?: unknown
  ek?: unknown
  spk_id?: unknown
  opk_id?: unknown
}

/** Stable, key-ordered serialization of the v2 X3DH header. */
function v2HeaderBytes({ ephemeralPubB64, spkId, opkId }: {
  ephemeralPubB64: string
  spkId: string
  opkId: string | null | undefined
}): Uint8Array {
  // Fixed key order so the bytes bound into the AAD match on both sides.
  return new TextEncoder().encode(
    JSON.stringify({ v: 2, ek: ephemeralPubB64, spk_id: spkId, opk_id: opkId ?? null }),
  )
}

function v2Aad(from: string, to: string, session: string, headerBytes: Uint8Array): Uint8Array {
  const base = aad(from, to, session)
  const out = new Uint8Array(base.length + headerBytes.length)
  out.set(base, 0)
  out.set(headerBytes, base.length)
  return out
}

/** Read the blob version byte (1 or 2) without decrypting. */
export function relayBlobVersion(blobB64: string): number {
  const raw = b64ToBytes(blobB64)
  if (raw.length < 1) throw new Error('relay blob empty')
  return raw[0]!
}

/** Arguments to {@link sealRelayBlobV2}. */
export interface SealRelayBlobV2Args {
  plaintext: Uint8Array
  /** 32-byte X3DH SK (from x3dhInitiate) */
  key: Uint8Array
  /** sender X25519 ephemeral public key */
  ephemeralPub: Uint8Array
  /** recipient signed-prekey id used */
  signedPreKeyId: string
  /** recipient one-time-prekey id, or null */
  oneTimePreKeyId: string | null | undefined
  from: string
  to: string
  session: string
}

/** Seal `plaintext` under a v2 (X3DH) content key. @returns blob_b64 */
export function sealRelayBlobV2({
  plaintext, key, ephemeralPub, signedPreKeyId, oneTimePreKeyId, from, to, session,
}: SealRelayBlobV2Args): string {
  const header = v2HeaderBytes({
    ephemeralPubB64: bytesToB64(ephemeralPub),
    spkId: signedPreKeyId,
    opkId: oneTimePreKeyId ?? null,
  })
  if (header.length > 0xffff) throw new Error('v2 header too large')
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN))
  const sealed = xchacha20poly1305(key, nonce, v2Aad(from, to, session, header)).encrypt(plaintext)

  const out = new Uint8Array(1 + 2 + header.length + NONCE_LEN + sealed.length)
  let o = 0
  out[o++] = BOX_VERSION_V2
  out[o++] = (header.length >> 8) & 0xff
  out[o++] = header.length & 0xff
  out.set(header, o); o += header.length
  out.set(nonce, o); o += NONCE_LEN
  out.set(sealed, o)
  return bytesToB64(out)
}

/** A parsed (but not yet decrypted) v2 relay blob, as returned by {@link parseRelayBlobV2}. */
export interface ParsedRelayBlobV2 {
  version: 2
  ephemeralPub: Uint8Array
  signedPreKeyId: string
  oneTimePreKeyId: string | null
  headerBytes: Uint8Array
  nonce: Uint8Array
  sealed: Uint8Array
}

/**
 * Parse a v2 blob's clear header WITHOUT decrypting, so the recipient can pick
 * the right prekeys and run X3DHRespond before opening.
 */
export function parseRelayBlobV2(blobB64: string): ParsedRelayBlobV2 {
  const raw = b64ToBytes(blobB64)
  if (raw.length < 1 + 2) throw new Error('relay blob too short')
  if (raw[0] !== BOX_VERSION_V2) throw new Error('unsupported relay blob version ' + raw[0])
  const headerLen = (raw[1]! << 8) | raw[2]!
  const headerStart = 3
  const nonceStart = headerStart + headerLen
  const sealedStart = nonceStart + NONCE_LEN
  if (raw.length < sealedStart + 16) throw new Error('relay blob too short')
  const headerBytes = raw.subarray(headerStart, nonceStart)
  let hdr: V2HeaderJSON
  try {
    hdr = JSON.parse(new TextDecoder().decode(headerBytes)) as V2HeaderJSON
  } catch {
    throw new Error('relay blob header malformed')
  }
  if (hdr.v !== 2 || typeof hdr.ek !== 'string' || typeof hdr.spk_id !== 'string') {
    throw new Error('relay blob header invalid')
  }
  const ephemeralPub = b64ToBytes(hdr.ek)
  if (ephemeralPub.length !== 32) throw new Error('relay blob bad ephemeral key')
  return {
    version: 2,
    ephemeralPub,
    signedPreKeyId: hdr.spk_id,
    oneTimePreKeyId: (hdr.opk_id as string | null | undefined) ?? null,
    headerBytes,
    nonce: raw.subarray(nonceStart, sealedStart),
    sealed: raw.subarray(sealedStart),
  }
}

/** Arguments to {@link openRelayBlobV2}. */
export interface OpenRelayBlobV2Args {
  parsed: ParsedRelayBlobV2
  /** 32-byte X3DH SK (from x3dhRespond) */
  key: Uint8Array
  from: string
  to: string
  session: string
}

/**
 * Open a v2 blob given the X3DH SK derived from its parsed header.
 * @returns plaintext
 * @throws on tamper / wrong key (AEAD failure)
 */
export function openRelayBlobV2({ parsed, key, from, to, session }: OpenRelayBlobV2Args): Uint8Array {
  return xchacha20poly1305(
    key, parsed.nonce, v2Aad(from, to, session, parsed.headerBytes),
  ).decrypt(parsed.sealed)
}
