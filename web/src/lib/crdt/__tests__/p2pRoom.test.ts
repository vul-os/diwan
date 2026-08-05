import { describe, it, expect } from 'vitest'
import {
  generateInvite, parseInvite, deriveRoomKeys,
  sealFrame, openFrame, bytesToB64url, b64urlToBytes,
  type RoomKeys,
} from '../p2pRoom.js'

// ---------------------------------------------------------------------------
// Invite parse/generate round-trip
// ---------------------------------------------------------------------------

describe('invite generate/parse round-trip', () => {
  it('round-trips an rw invite through link and bare fragment', async () => {
    const gen = await generateInvite({ cap: 'rw', baseUrl: 'https://ex.test/docs/collab' })
    expect(gen.link).toContain('#vp2p=')
    expect(gen.cap).toBe('rw')
    expect(gen.roomId).toMatch(/^[0-9a-f]{32}$/)

    const parsed = await parseInvite(gen.link)
    expect(parsed.cap).toBe('rw')
    expect(parsed.roomId).toBe(gen.roomId)
    expect([...parsed.roomKey]).toEqual([...gen.roomKey])

    // Bare fragment (no origin) must also parse.
    const bare = await parseInvite(gen.fragment)
    expect(bare.roomId).toBe(gen.roomId)
  })

  it('round-trips an ro invite', async () => {
    const gen = await generateInvite({ cap: 'ro' })
    const parsed = await parseInvite(gen.link)
    expect(parsed.cap).toBe('ro')
  })

  it('ro link derived from an rw roomKey shares the same room', async () => {
    const rw = await generateInvite({ cap: 'rw' })
    const ro = await generateInvite({ cap: 'ro', roomKey: rw.roomKey })
    expect(ro.roomId).toBe(rw.roomId)
    expect(ro.cap).toBe('ro')
  })

  it('rejects a malformed invite (fail closed, never opens an unkeyed room)', async () => {
    await expect(parseInvite('https://ex.test/#vp2p=not-valid-base64-json!!'))
      .rejects.toThrow()
    await expect(parseInvite('')).rejects.toThrow()
    await expect(parseInvite('https://ex.test/#nothinghere')).rejects.toThrow()
  })

  it('rejects a link whose roomId was swapped to point at another room', async () => {
    const a = await generateInvite({ cap: 'rw' })
    const other = await generateInvite({ cap: 'rw' })
    // Rebuild a's fragment but claim `other`'s roomId.
    const payloadB64 = a.fragment.replace(/^vp2p=/, '')
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64)))
    payload.r = other.roomId // forge the advertised roomId
    const forged = 'vp2p=' + bytesToB64url(new TextEncoder().encode(JSON.stringify(payload)))
    await expect(parseInvite(forged)).rejects.toThrow(/roomId does not match/)
  })
})

// ---------------------------------------------------------------------------
// AEAD encrypt/decrypt + per-message nonce uniqueness + content-blindness
// ---------------------------------------------------------------------------

describe('room frame AEAD', () => {
  async function roomFrom(roomKey: Uint8Array): Promise<RoomKeys> {
    const k = await deriveRoomKeys(roomKey)
    return { encKey: k.encKey, macKeyRw: k.macKeyRw, roomId: k.roomId }
  }

  it('encrypts and decrypts a message', async () => {
    const { roomKey } = await generateInvite({ cap: 'rw' })
    const room = await roomFrom(roomKey)
    const msg = { type: 'op', op: { k: 1, id: { r: 'a', c: 1 }, v: 72 } }
    const frame = await sealFrame(room, msg)
    const { msg: out } = await openFrame(room, frame)
    expect(out).toEqual(msg)
  })

  it('uses a fresh per-message nonce (no reuse across identical plaintexts)', async () => {
    const { roomKey } = await generateInvite({ cap: 'rw' })
    const room = await roomFrom(roomKey)
    const msg = { type: 'op', op: { v: 65 } }
    const nonces = new Set()
    for (let i = 0; i < 200; i++) {
      const frame = await sealFrame(room, msg)
      const bytes = b64urlToBytes(frame)
      // frame = magic(5) || flags(1) || nonce(12) || ct
      const nonce = bytes.subarray(6, 18)
      const key = bytesToB64url(nonce)
      expect(nonces.has(key)).toBe(false)   // never reused
      nonces.add(key)
      // Two seals of the SAME plaintext must produce DIFFERENT ciphertext.
    }
    const f1 = await sealFrame(room, msg)
    const f2 = await sealFrame(room, msg)
    expect(f1).not.toBe(f2)
  })

  it('a wrong-key peer (and the relay) cannot read the frame — content-blind', async () => {
    const alice = await generateInvite({ cap: 'rw' })
    const mallory = await generateInvite({ cap: 'rw' }) // different roomKey
    const aliceRoom = await roomFrom(alice.roomKey)
    const malloryRoom = await roomFrom(mallory.roomKey)

    const frame = await sealFrame(aliceRoom, { type: 'op', op: { secret: 'hello' } })
    // Mallory holds a *different* key: AEAD open MUST fail (fail-closed).
    await expect(openFrame(malloryRoom, frame)).rejects.toThrow()
  })

  it('rejects a tampered ciphertext (AEAD auth)', async () => {
    const { roomKey } = await generateInvite({ cap: 'rw' })
    const room = await roomFrom(roomKey)
    const frame = await sealFrame(room, { type: 'op', op: { v: 1 } })
    const bytes = b64urlToBytes(frame)
    bytes[bytes.length - 1] ^= 0xff  // flip a ciphertext byte
    await expect(openFrame(room, bytesToB64url(bytes))).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// RW-MAC / read-only authority
// ---------------------------------------------------------------------------

describe('RW authority (ro cannot forge authoritative frames)', () => {
  it('an rw peer verifies its own authoritative op frame', async () => {
    const { roomKey } = await generateInvite({ cap: 'rw' })
    const keys = await deriveRoomKeys(roomKey)
    const rw = { encKey: keys.encKey, macKeyRw: keys.macKeyRw, roomId: keys.roomId }
    const frame = await sealFrame(rw, { type: 'op', op: { v: 1 } }, { authoritative: true })
    const { authoritative } = await openFrame(rw, frame)
    expect(authoritative).toBe(true)
  })

  it('a ro peer holds encKey but NOT macKeyRw, so it cannot sign authoritative frames', async () => {
    const { roomKey } = await generateInvite({ cap: 'ro' })
    const keys = await deriveRoomKeys(roomKey)
    // ro session strips macKeyRw (see YP2PCollabSession.fromInvite).
    const ro = { encKey: keys.encKey, macKeyRw: null, roomId: keys.roomId }
    await expect(
      sealFrame(ro, { type: 'op', op: { v: 1 } }, { authoritative: true }),
    ).rejects.toThrow(/RW authority/)
  })

  it('an rw peer sees a ro peer\'s op frame as NON-authoritative and would reject it', async () => {
    const { roomKey } = await generateInvite({ cap: 'rw' })
    const keys = await deriveRoomKeys(roomKey)
    const rw = { encKey: keys.encKey, macKeyRw: keys.macKeyRw, roomId: keys.roomId }
    const ro = { encKey: keys.encKey, macKeyRw: null, roomId: keys.roomId }
    // ro peer can only produce a NON-authoritative op frame (it decrypts fine).
    const frame = await sealFrame(ro, { type: 'op', op: { v: 1 } })
    const { msg, authoritative } = await openFrame(rw, frame)
    expect((msg as { type: string }).type).toBe('op')          // rw can read it
    expect(authoritative).toBe(false)    // but it is NOT authoritative → rejected
  })
})
