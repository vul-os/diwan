/**
 * prekeys.ts — X3DH-style forward-secret content keys for the relay-fallback path.
 *
 * ## Why
 *
 * relayBox.ts v1 derives the per-message AEAD key with STATIC-STATIC X25519 ECDH
 * (`deriveKey(senderBoxPriv, recipientBoxPub)`): both sides use their long-term
 * (per-session) box key, so the shared key is the SAME for every message. A
 * stolen box/identity key therefore retroactively decrypts EVERY captured
 * relay blob — there is NO forward secrecy.
 *
 * ## Scheme (X3DH, matching the Go reference EXACTLY)
 *
 * This is the browser/JS port of `vulos/backend/services/peering/prekeys.go`
 * (`X3DHInitiate` / `X3DHRespond` / `x3dhKDF`). Each identity publishes a prekey
 * bundle:
 *   - its long-term identity key (here: the per-session X25519 box key, already
 *     announced as `boxPubKey` — used only in DH1/DH2 to AUTHENTICATE),
 *   - a medium-term SIGNED prekey (X25519), signed by the session ECDSA identity
 *     (mirroring how depositPubKey / boxPubKey are announced),
 *   - a pool of ONE-TIME prekeys (X25519), each consumed at most once.
 *
 * A sender derives a per-message key from a FRESH EPHEMERAL key plus the
 * recipient's prekeys, exactly as in Signal's X3DH:
 *
 *   DH1 = DH(IK_send, SPK_recv)     // authenticates the sender's identity
 *   DH2 = DH(EK_send, IK_recv)      // authenticates the recipient's identity
 *   DH3 = DH(EK_send, SPK_recv)     // contributes forward secrecy
 *   DH4 = DH(EK_send, OPK_recv)     // one-time; strongest forward secrecy
 *   SK  = HKDF-SHA256(0xFF*32 || DH1 || DH2 || DH3 || DH4,
 *                     salt = sort(idA,idB)[0] + ":" + sort(...)[1],
 *                     info = "vula-x3dh-content-v2")
 *
 * The identity key appears only in DH1/DH2 (AUTHENTICATION); the secrecy of SK
 * rests on the EPHEMERAL key (discarded after use) and the recipient's one-time
 * prekey (DELETED on first use).
 *
 * ## KDF byte-compatibility with Go
 *
 * `x3dhKDF` below reproduces `prekeys.go:x3dhKDF` byte-for-byte:
 *   ikm  = 0xFF repeated 32 times, then the DH concatenation;
 *   salt = the two ids sorted lexicographically and joined with ':';
 *   info = "vula-x3dh-content-v2"; HKDF-SHA256, 32-byte output.
 * Given identical X25519 key bytes a Go responder and this JS initiator derive
 * the SAME SK (see prekeys.test.ts "matches the Go reference vector").
 *
 * Pure JS, audited @noble/* primitives only — no native deps.
 */

import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToB64, b64ToBytes } from './relayBox.js'

/** HKDF info label — MUST equal prekeys.go `x3dhHKDFInfo`. */
const X3DH_HKDF_INFO = 'vula-x3dh-content-v2'
const X25519_LEN = 32

const _enc = new TextEncoder()

// @noble/curves 2.x exposes randomSecretKey(); fall back to the older name for
// any older/newer copy on the resolution path that still exposes it under that
// name (not present in the installed version's own .d.ts, hence the cast).
type X25519UtilsCompat = { randomSecretKey?: () => Uint8Array, randomPrivateKey?: () => Uint8Array }

function _randPriv(): Uint8Array {
  const utils = x25519.utils as X25519UtilsCompat
  return utils.randomSecretKey ? utils.randomSecretKey() : utils.randomPrivateKey!()
}

/** Random opaque key id (mirrors prekeys.go newKeyID: 12 random bytes, b64url). */
function newKeyID(): string {
  const b = crypto.getRandomValues(new Uint8Array(12))
  // base64url, no padding (RawURLEncoding).
  return bytesToB64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// ─── KDF (byte-identical to prekeys.go:x3dhKDF) ───────────────────────────────

/**
 * Derive the 32-byte content key from the DH concatenation and the two identity
 * ids. Matches `prekeys.go:x3dhKDF` exactly:
 *   ikm  = 0xFF*32 || dhConcat
 *   salt = sort(idA,idB)[0] + ":" + sort(...)[1]
 *   info = "vula-x3dh-content-v2"
 *
 * @param dhConcat  DH1||DH2||DH3[||DH4]
 * @returns 32-byte SK
 */
export function x3dhKDF(dhConcat: Uint8Array, idA: string, idB: string): Uint8Array {
  const ikm = new Uint8Array(32 + dhConcat.length)
  ikm.fill(0xff, 0, 32)
  ikm.set(dhConcat, 32)

  let lo = idA, hi = idB
  if (lo > hi) { lo = idB; hi = idA }
  const salt = _enc.encode(`${lo}:${hi}`)
  return hkdf(sha256, ikm, salt, _enc.encode(X3DH_HKDF_INFO), 32)
}

function _concat(parts: Uint8Array[]): Uint8Array {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let off = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}

function _x25519(priv: Uint8Array, pub: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(priv, pub)
}

// ─── Sender side (X3DHInitiate) ───────────────────────────────────────────────

/** Arguments to {@link x3dhInitiate}. */
export interface X3dhInitiateArgs {
  /** sender long-term (box) X25519 private — IK_send */
  identityPriv: Uint8Array
  /** recipient long-term (box) X25519 public — IK_recv */
  recipientIdentityPub: Uint8Array
  /** recipient signed prekey public — SPK_recv */
  signedPreKeyPub: Uint8Array
  /** recipient one-time prekey public — OPK_recv */
  oneTimePreKeyPub?: Uint8Array | null
  /** sender identity id (salt input) */
  senderId: string
  /** recipient identity id (salt input) */
  recipientId: string
}

/** Result of {@link x3dhInitiate}. */
export interface X3dhInitiateResult {
  ephemeralPub: Uint8Array
  sk: Uint8Array
}

/**
 * Derive a forward-secret content key SK for sending to a recipient bundle.
 * Mirrors `prekeys.go:X3DHInitiate`. Generates a fresh ephemeral key.
 */
export function x3dhInitiate({
  identityPriv,
  recipientIdentityPub,
  signedPreKeyPub,
  oneTimePreKeyPub = null,
  senderId,
  recipientId,
}: X3dhInitiateArgs): X3dhInitiateResult {
  const ekPriv = _randPriv()
  const ekPub = x25519.getPublicKey(ekPriv)

  // DH1 = DH(IK_send, SPK_recv); DH2 = DH(EK, IK_recv); DH3 = DH(EK, SPK_recv).
  const dh1 = _x25519(identityPriv, signedPreKeyPub)
  const dh2 = _x25519(ekPriv, recipientIdentityPub)
  const dh3 = _x25519(ekPriv, signedPreKeyPub)
  const parts = [dh1, dh2, dh3]

  // DH4 = DH(EK, OPK_recv) when a one-time prekey is offered (strongest FS).
  if (oneTimePreKeyPub && oneTimePreKeyPub.length === X25519_LEN) {
    parts.push(_x25519(ekPriv, oneTimePreKeyPub))
  }

  const sk = x3dhKDF(_concat(parts), senderId, recipientId)
  return { ephemeralPub: ekPub, sk }
}

// ─── Recipient side (X3DHRespond) ─────────────────────────────────────────────

/** Arguments to {@link x3dhRespond}. */
export interface X3dhRespondArgs {
  /** recipient long-term (box) X25519 private — IK_recv */
  identityPriv: Uint8Array
  /** sender long-term (box) X25519 public — IK_send */
  senderIdentityPub: Uint8Array
  /**
   * recipient signed prekey private — SPK_recv. Nullable because it typically
   * comes straight from `PreKeyStore.signedPreKeyPriv(id)`, which returns null
   * on an id it does not hold; the caller is expected to have already
   * validated the id came from a bundle this store published.
   */
  signedPreKeyPriv: Uint8Array | null
  /** recipient one-time prekey private — OPK_recv */
  oneTimePreKeyPriv?: Uint8Array | null
  /** sender ephemeral public — EK */
  ephemeralPub: Uint8Array
  senderId: string
  recipientId: string
}

/**
 * Re-derive the same SK on the recipient side. Mirrors `prekeys.go:X3DHRespond`.
 * The one-time prekey (when used) MUST be deleted by the caller AFTER a
 * successful AEAD open — this module returns the SK only.
 *
 * @returns 32-byte SK
 */
export function x3dhRespond({
  identityPriv,
  senderIdentityPub,
  signedPreKeyPriv,
  oneTimePreKeyPriv = null,
  ephemeralPub,
  senderId,
  recipientId,
}: X3dhRespondArgs): Uint8Array {
  if (!ephemeralPub || ephemeralPub.length !== X25519_LEN) {
    throw new Error('prekeys: bad ephemeral key')
  }
  // Mirror the sender's DHs (ECDH commutes). A null signedPreKeyPriv (unknown
  // id) is passed straight through to the DH primitive rather than checked
  // here — it will throw inside x25519.getSharedSecret, exactly as the
  // pre-conversion JS did.
  const dh1 = _x25519(signedPreKeyPriv as Uint8Array, senderIdentityPub)   // DH(SPK_recv, IK_send)
  const dh2 = _x25519(identityPriv, ephemeralPub)                          // DH(IK_recv, EK)
  const dh3 = _x25519(signedPreKeyPriv as Uint8Array, ephemeralPub)        // DH(SPK_recv, EK)
  const parts = [dh1, dh2, dh3]
  if (oneTimePreKeyPriv) {
    if (oneTimePreKeyPriv.length !== X25519_LEN) throw new Error('prekeys: bad one-time prekey')
    parts.push(_x25519(oneTimePreKeyPriv, ephemeralPub))     // DH(OPK_recv, EK)
  }
  return x3dhKDF(_concat(parts), senderId, recipientId)
}

// ─── Signed-prekey signature (ECDSA, mirroring depositPubKey) ─────────────────

/** A signed prekey's PRIVATE record, as held by {@link PreKeyStore}. */
export interface SignedPreKey {
  id: string
  priv: Uint8Array
  pub: Uint8Array
  pubB64: string
  sigB64: string
}

/** The publishable {id, pub, sig} form of a signed prekey. */
export interface SignedPreKeyPublic {
  id: string
  pub: string
  sig: string
}

/** Signs raw bytes with the ECDSA identity key, returning a base64 signature. */
export type SignRawFn = (msgBytes: Uint8Array) => Promise<string>

/** Verifies a base64 ECDSA signature over raw bytes. */
export type VerifyRawFn = (msgBytes: Uint8Array, sigB64: string) => Promise<boolean>

/**
 * Generate a signed prekey: a fresh X25519 keypair whose PUBLIC key is signed by
 * the session ECDSA identity. Analogous to prekeys.go's signed prekey except the
 * signature is ECDSA P-256 (the relay identity) rather than Ed25519.
 */
export async function generateSignedPreKey(signRawFn: SignRawFn): Promise<SignedPreKey> {
  const priv = _randPriv()
  const pub = x25519.getPublicKey(priv)
  const sigB64 = await signRawFn(pub)
  return { id: newKeyID(), priv, pub, pubB64: bytesToB64(pub), sigB64 }
}

/**
 * Verify a peer's signed prekey signature using the peer's stored ECDSA public
 * key. Fails closed (returns false on any error). JS analog of
 * prekeys.go:VerifySignedPreKey.
 *
 * @param signedPreKey  base64 pub + sig
 */
export async function verifySignedPreKey(verifyRawFn: VerifyRawFn, signedPreKey: { pub: string, sig: string }): Promise<boolean> {
  try {
    const pub = b64ToBytes(signedPreKey.pub)
    if (pub.length !== X25519_LEN) return false
    return await verifyRawFn(pub, signedPreKey.sig)
  } catch {
    return false
  }
}

// ─── PreKeyStore (per-session private prekey material) ────────────────────────

/** The publishable prekey bundle produced by {@link PreKeyStore.publicBundle}. */
export interface PublicPreKeyBundle {
  identity_vula_id: string
  signed_prekey: SignedPreKeyPublic
  one_time_prekeys: Array<{ id: string, pub: string }>
}

/**
 * Owns this peer's PRIVATE prekey material (signed prekey + one-time prekey pool)
 * and produces the publishable bundle. In-memory / per-session (the relay path is
 * per-session and ephemeral, so there is no on-disk persistence as in the Go
 * server). Consumed one-time prekeys are deleted (forward secrecy).
 */
export class PreKeyStore {
  private _signed: SignedPreKey
  private _opks: Map<string, { priv: Uint8Array, pub: Uint8Array }>

  constructor({ signedPreKey, oneTimeCount = 8 }: { signedPreKey: SignedPreKey, oneTimeCount?: number }) {
    this._signed = signedPreKey
    this._opks = new Map()
    if (oneTimeCount > 0) this.replenish(oneTimeCount)
  }

  /** Build a store, generating + signing a fresh signed prekey. */
  static async create(signRawFn: SignRawFn, oneTimeCount = 8): Promise<PreKeyStore> {
    const signedPreKey = await generateSignedPreKey(signRawFn)
    return new PreKeyStore({ signedPreKey, oneTimeCount })
  }

  /** Top the one-time prekey pool back up to `target`. */
  replenish(target: number): void {
    while (this._opks.size < target) {
      const priv = _randPriv()
      this._opks.set(newKeyID(), { priv, pub: x25519.getPublicKey(priv) })
    }
  }

  /** Number of one-time prekeys remaining. */
  oneTimePreKeyCount(): number {
    return this._opks.size
  }

  /** The signed prekey id. */
  get signedPreKeyId(): string {
    return this._signed.id
  }

  /**
   * The publishable bundle (signed prekey + remaining one-time prekey PUBLICS).
   * @param identityVulaId  this peer's identity id
   */
  publicBundle(identityVulaId: string): PublicPreKeyBundle {
    const otps: Array<{ id: string, pub: string }> = []
    for (const [id, { pub }] of this._opks) otps.push({ id, pub: bytesToB64(pub) })
    return {
      identity_vula_id: identityVulaId,
      signed_prekey: { id: this._signed.id, pub: this._signed.pubB64, sig: this._signed.sigB64 },
      one_time_prekeys: otps,
    }
  }

  /** Private scalar of the signed prekey if `id` matches, else null. */
  signedPreKeyPriv(id: string): Uint8Array | null {
    return id === this._signed.id ? this._signed.priv : null
  }

  /** Private scalar of a one-time prekey by id, else null (no deletion). */
  oneTimePreKeyPriv(id: string | null | undefined): Uint8Array | null {
    return (id != null ? this._opks.get(id)?.priv : undefined) ?? null
  }

  /**
   * Delete a one-time prekey (forward secrecy). Returns true if it existed.
   * After this, the captured message can never again be decrypted via that OPK.
   */
  consumeOneTimePreKey(id: string | null | undefined): boolean {
    return id != null && this._opks.delete(id)
  }
}
