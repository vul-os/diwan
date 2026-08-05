/**
 * canonicalInterop.test.ts — the browser half of a two-language pin.
 *
 * Diwan now serves its OWN peer-discovery surface from the Go binary
 * (backend/rendezvous), and every request to it is authenticated by an Ed25519
 * signature over `canonicalMessage(domain, fields)`. That message is built TWICE,
 * independently: here in JavaScript, and in Go by `CanonicalMessage`. They are
 * separate implementations of one byte format.
 *
 * If they drift by a single byte — a different length-prefix width, endianness,
 * field order, or number formatting — every signature stops verifying and
 * collaboration dies with a wall of 403s that looks like a crypto bug rather than
 * what it is. Neither side's own unit tests would notice, because each is
 * internally consistent.
 *
 * So the format is pinned to FIXED VECTORS on both sides:
 *
 *   • this file, and
 *   • backend/rendezvous/canonical_interop_test.go
 *
 * They carry the SAME vectors. Both must be edited together, deliberately, or one
 * of them fails. The Go file additionally verifies the signatures below with
 * crypto/ed25519, so "the browser can authenticate to the server" is proven by
 * execution on both sides rather than asserted in a comment.
 */

import { describe, it, expect } from 'vitest'
import { canonicalMessage, RendezvousIdentity, RENDEZVOUS_DOMAINS } from '../rendezvous.js'

/** 32 bytes of 0x07 — the seed both languages' vectors were generated from. */
const SEED = new Uint8Array(32).fill(7)

/** The base64url address that seed must produce. Pinned so a change in how either
 *  runtime derives a public key from a seed is caught here rather than in the
 *  field. */
const PUBLIC_KEY = '6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw'

const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

interface Vector {
  name: string
  domain: string
  fields: string[]
  msgHex: string
  sig: string
}

/**
 * The vectors. `<KEY>` is substituted with PUBLIC_KEY so the fields read the way
 * the real client builds them (a key is both the signer and, for a deposit, the
 * address).
 */
const VECTORS: Vector[] = [
  {
    name: 'announce',
    domain: RENDEZVOUS_DOMAINS.announce,
    fields: ['<KEY>', '1800000000', '0', 'nonce-abc', 'vulos-fabric'],
    msgHex:
      '0000001476756c6f732d7264762f616e6e6f756e63652f310000002b366b7073592d4b635567712d3956423745793' +
      '7462d5a56486471362d766e755351683771615252473069770000000a313830303030303030300000000130000000096e6f' +
      '6e63652d6162630000000c76756c6f732d666162726963',
    sig: 'zzZTLm_MTwqhAnPhTS_RTcieaku7b_-BIGx5RPqhDw_pje0HR1y1EZBSDaMNfzsfnxUTVp2s5daIa0knUxKJCg',
  },
  {
    name: 'signal-deposit',
    domain: RENDEZVOUS_DOMAINS.signalDeposit,
    fields: ['<KEY>', '<KEY>', '1800000000', '0', 'nonce-def', 'aGVsbG8'],
    msgHex:
      '0000001a76756c6f732d7264762f7369676e616c2d6465706f7369742f310000002b366b7073592d4b635567712d3956' +
      '4237457937462d5a56486471362d766e755351683771615252473069770000002b366b7073592d4b635567712d3956423745' +
      '7937462d5a56486471362d766e755351683771615252473069770000000a3138303030303030303000000001300000000' +
      '96e6f6e63652d6465660000000761475673624738',
    sig: 'UWsF7I6H1bhOIi_J6RzwFguipgMv0TbO8-aftzb4niQXzCK-i97fE63-ZKgfoxqs9XUnZUrjFu2eVIEfvynqCw',
  },
  {
    name: 'signal-ack',
    domain: RENDEZVOUS_DOMAINS.signalAck,
    fields: ['<KEY>', '1800000000', 'nonce-ghi', 'id1', 'id2'],
    msgHex:
      '0000001676756c6f732d7264762f7369676e616c2d61636b2f310000002b366b7073592d4b635567712d395642374579' +
      '37462d5a56486471362d766e755351683771615252473069770000000a31383030303030303030000000096e6f6e63652d' +
      '6768690000000369643100000003696432',
    sig: '0_ikwrSFCnVZ3ZD_Mqsl2VZXX0hivnRNl3Su1aldfYIh35yb5_N19YF8m2c9VM6ON91wnSrgPkfitN0-lXs-DA',
  },
]

describe('rendezvous canonical message — cross-language pin', () => {
  const id = new RendezvousIdentity(SEED)
  const resolve = (fields: string[]): string[] => fields.map((f) => (f === '<KEY>' ? id.key : f))

  it('derives the pinned public key from the pinned seed', () => {
    expect(id.key).toBe(PUBLIC_KEY)
  })

  for (const v of VECTORS) {
    it(`builds the pinned canonical bytes for ${v.name}`, () => {
      const msg = canonicalMessage(v.domain, resolve(v.fields))
      expect(hex(msg)).toBe(v.msgHex)
    })

    it(`produces the pinned signature for ${v.name} (Ed25519 is deterministic)`, () => {
      const msg = canonicalMessage(v.domain, resolve(v.fields))
      expect(id.sign(msg)).toBe(v.sig)
    })
  }

  it('separates domains: the same fields under two domains sign differently', () => {
    // Without this, an announce signature (key/ts/nonce) would be spendable as a
    // withdraw over the same three fields — one captured heartbeat would let
    // anyone delete a peer's presence.
    const fields = [id.key, '1800000000', 'nonce-x']
    const a = canonicalMessage(RENDEZVOUS_DOMAINS.announce, fields)
    const b = canonicalMessage(RENDEZVOUS_DOMAINS.withdraw, fields)
    expect(hex(a)).not.toBe(hex(b))
    expect(id.sign(a)).not.toBe(id.sign(b))
  })

  it('is unambiguous across field boundaries (length prefixes, not concatenation)', () => {
    // ['ab','c'] and ['a','bc'] must NOT sign identically, or a signature could be
    // re-purposed for a different request by moving one byte across a boundary.
    const one = canonicalMessage('d', ['ab', 'c'])
    const two = canonicalMessage('d', ['a', 'bc'])
    expect(hex(one)).not.toBe(hex(two))
  })
})
