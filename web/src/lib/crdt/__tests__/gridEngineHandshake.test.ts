/**
 * gridEngineHandshake.test.js — Sheets refuses to sync across an engine
 * mismatch, and proves what it was doing before.
 *
 * THE CLAIM UNDER TEST. `grid.js` and `substrateGrid.js` are both LWW grid
 * engines and both broadcast `{type:'grid_op', session, op}` — but their `op`
 * payloads are unrelated, and their total orders are different. Two peers on
 * different engines in one document therefore do not "merge badly"; they merge
 * NOTHING, permanently, while the presence pill reports "Live". These tests pin
 * that the session now detects it and stops, rather than sitting there looking
 * healthy.
 *
 * The first block is the important one: it demonstrates the OLD behaviour
 * directly against the CRDT internals, so the regression this guards is a
 * recorded fact rather than a description in a comment.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { GridSession, type GridLocalOpDetail } from '../grid.js'
import { SubstrateGridSession, initSubstrateSync } from '../substrateGrid.js'
import {
  GridEngineGuard, ENGINE_LOCAL_LWW, ENGINE_KOTVA_SYNC, HELLO_TYPE,
  classifyOp, classifySnapshot,
  SHAPE_LOCAL_LWW, SHAPE_KOTVA_SYNC, SHAPE_UNKNOWN, SHAPE_NONE,
  type EngineMismatch,
} from '../gridEngine.js'
import type { FabricClient } from '../../collab/webrtc/fabric.js'

// ---------------------------------------------------------------------------
// A shared in-process fabric: every session attached to one bus receives every
// frame any other session sends. This is exactly what a real room looks like to
// a grid session — FabricClient.send() broadcasts, and each peer's session
// filters by `msg.session`.
// ---------------------------------------------------------------------------
class Bus {
  clients: Set<FakeFabric>
  constructor() { this.clients = new Set() }
  attach(c: FakeFabric) { this.clients.add(c) }
}

class FakeFabric extends EventTarget {
  bus: Bus
  name: string
  sent: string[]
  constructor(bus: Bus, name: string) {
    super()
    this.bus = bus
    this.name = name
    this.sent = []
    bus.attach(this)
  }
  send(frame: string) {
    this.sent.push(frame)
    for (const peer of this.bus.clients) {
      if (peer === this) continue
      peer.dispatchEvent(new CustomEvent('message', {
        detail: { from: this.name, data: frame },
      }))
    }
  }
  sendTo() {}
  leave() {}
}

// FakeFabric only exercises the addEventListener/send surface GridSession and
// SubstrateGridSession actually call on their transport (see grid.ts /
// substrateGrid.ts) — the cast to the real FabricClient type is the same kind
// production itself does for its own transport casts elsewhere in this suite.
const asFabricClient = (f: FakeFabric): FabricClient => f as unknown as FabricClient

/** A wire frame this fabric emitted/received, decoded loosely for assertions. */
type WireFrame = { type: string, engine?: string, [key: string]: unknown }

/** Frames of a given wire type this fabric emitted. */
function framesOfType(fabric: FakeFabric, type: string): WireFrame[] {
  return fabric.sent.map((f) => JSON.parse(f) as WireFrame).filter((m) => m.type === type)
}

// `_ingestGridOp`/`_ingestWire` are private implementation details of
// GridSession/SubstrateGridSession; the first test in this file needs to drive
// them directly to demonstrate the pre-fix behaviour against the CRDT
// internals. Same reach-past-privacy cast as yP2PSession.test.ts's
// `asBroadcaster`.
type LegacyIngestable = { _ingestGridOp(op: unknown): boolean }
const asLegacyIngestable = (s: GridSession): LegacyIngestable => s as unknown as LegacyIngestable
type SubstrateIngestable = { _ingestWire(op: unknown): boolean }
const asSubstrateIngestable = (s: SubstrateGridSession): SubstrateIngestable => s as unknown as SubstrateIngestable

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  // The guard logs the mismatch at error level by design; keep the suite quiet
  // while still asserting it fired via the event/latch.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

// ---------------------------------------------------------------------------
// 1. Classification — the layer that catches a peer too old to advertise.
// ---------------------------------------------------------------------------
describe('op-shape classification', () => {
  it('recognises each engine by the shape of the op it emits', () => {
    expect(classifyOp({ kind: 1, id: '1_1_a', key: { r: 0, c: 0 }, v: 'x' })).toBe(SHAPE_LOCAL_LWW)
    expect(classifyOp({ kind: 2, id: '1_1_a', key: { r: 0, c: 0 } })).toBe(SHAPE_LOCAL_LWW)
    expect(classifyOp({ dsync: 1, b: 'AAEC' })).toBe(SHAPE_KOTVA_SYNC)
  })

  it('treats anything it cannot classify as FOREIGN, never as benign', () => {
    // Fail-closed: there is no shape that means "probably ours".
    expect(classifyOp({})).toBe(SHAPE_UNKNOWN)
    expect(classifyOp({ kind: 9 })).toBe(SHAPE_UNKNOWN)
    expect(classifyOp({ dsync: 2, b: 'AAEC' })).toBe(SHAPE_UNKNOWN)
    expect(classifyOp('nonsense')).toBe(SHAPE_UNKNOWN)
    expect(classifySnapshot('not-an-array')).toBe(SHAPE_UNKNOWN)
    expect(classifySnapshot([{ r: 0 }])).toBe(SHAPE_UNKNOWN)
  })

  it('an EMPTY snapshot carries no engine signal and must not accuse anyone', () => {
    // A peer that has typed nothing yet posts []. Latching on that would break
    // ordinary same-engine cold-join, which is the one false positive that would
    // make the whole guard worse than useless.
    expect(classifySnapshot([])).toBe(SHAPE_NONE)
    expect(classifyOp(null)).toBe(SHAPE_NONE)

    const guard = new GridEngineGuard(ENGINE_KOTVA_SYNC, () => {})
    expect(guard.observeShape(classifySnapshot([]))).toBe(false)
    expect(guard.ok).toBe(true)
  })
})

describe('GridEngineGuard', () => {
  it('latches closed once and calls back exactly once', () => {
    const seen: EngineMismatch[] = []
    const guard = new GridEngineGuard(ENGINE_LOCAL_LWW, (i) => seen.push(i))
    expect(guard.ok).toBe(true)
    expect(guard.observeAdvertisement(ENGINE_KOTVA_SYNC)).toBe(true)
    expect(guard.observeAdvertisement(ENGINE_KOTVA_SYNC)).toBe(true)
    expect(guard.observeShape(SHAPE_LOCAL_LWW)).toBe(true) // even our OWN shape
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ local: ENGINE_LOCAL_LWW, remote: ENGINE_KOTVA_SYNC, via: 'advertisement' })
    expect(guard.ok).toBe(false)
  })

  it('does not latch on its own engine', () => {
    const guard = new GridEngineGuard(ENGINE_LOCAL_LWW, () => { throw new Error('must not fire') })
    expect(guard.observeAdvertisement(ENGINE_LOCAL_LWW)).toBe(false)
    expect(guard.observeShape(SHAPE_LOCAL_LWW)).toBe(false)
    expect(guard.ok).toBe(true)
  })

  it('a peer that advertises NOTHING is foreign, not trusted', () => {
    const guard = new GridEngineGuard(ENGINE_LOCAL_LWW, () => {})
    expect(guard.observeAdvertisement(undefined)).toBe(true)
    expect(guard.mismatch!.remote).toBe('unadvertised')
  })
})

// ---------------------------------------------------------------------------
// 2. Same engine: nothing changes. The guard must not cost convergence.
// ---------------------------------------------------------------------------
describe('two peers on the SAME engine still converge (no false positive)', () => {
  it('grid.js ↔ grid.js', () => {
    const bus = new Bus()
    const a = new GridSession({ sessionId: 'f1', replicaId: 'A', fabricClient: asFabricClient(new FakeFabric(bus, 'A')) })
    const b = new GridSession({ sessionId: 'f1', replicaId: 'B', fabricClient: asFabricClient(new FakeFabric(bus, 'B')) })

    a.setCell(0, 0, 'alpha')
    b.setCell(1, 1, 'beta')

    expect(a.engineMismatch).toBeNull()
    expect(b.engineMismatch).toBeNull()
    expect(a.cells()).toEqual(b.cells())
    expect(a.cells()).toEqual([{ r: 0, c: 0, v: 'alpha' }, { r: 1, c: 1, v: 'beta' }])
    a.destroy(); b.destroy()
  })

  it('and both advertise, and the reply does not ping-pong forever', () => {
    const bus = new Bus()
    const fa = new FakeFabric(bus, 'A')
    const a = new GridSession({ sessionId: 'f2', replicaId: 'A', fabricClient: asFabricClient(fa) })
    const fb = new FakeFabric(bus, 'B')
    const b = new GridSession({ sessionId: 'f2', replicaId: 'B', fabricClient: asFabricClient(fb) })

    // A: its own opening hello, then one reply to B's hello, then one reply to
    // B's snapshot request if it makes one. Bounded, not a storm.
    const aHellos = framesOfType(fa, HELLO_TYPE)
    const bHellos = framesOfType(fb, HELLO_TYPE)
    expect(aHellos.length).toBeGreaterThanOrEqual(1)
    expect(aHellos.length).toBeLessThanOrEqual(3)
    expect(bHellos.length).toBeGreaterThanOrEqual(1)
    expect(bHellos.length).toBeLessThanOrEqual(3)
    expect(aHellos[0].engine).toBe(ENGINE_LOCAL_LWW)
    expect(a.engineMismatch).toBeNull()
    expect(b.engineMismatch).toBeNull()
    a.destroy(); b.destroy()
  })
})

// ---------------------------------------------------------------------------
// 3. Mixed engines. This is the whole point.
// ---------------------------------------------------------------------------
describe('a MIXED room: grid.js meets substrateGrid.js', () => {
  beforeAll(async () => { await initSubstrateSync() })

  it('WHAT IT USED TO DO: the two engines silently exchange nothing', () => {
    // Reproduced against the CRDT internals, bypassing the guard, so the bug
    // this change fixes is on the record rather than only in a comment.
    const legacy = new GridSession({ sessionId: 'raw', replicaId: 'L', fabricClient: null })
    const sub = new SubstrateGridSession({ sessionId: 'raw', replicaId: 'S', fabricClient: null })

    sub.setCell(0, 0, 'from-substrate')
    const substrateOp: unknown = JSON.parse(JSON.stringify(sub.logSnapshotData()[0]))
    legacy.setCell(0, 0, 'from-legacy')
    const legacyOp = { kind: 1, id: '1_1_L', key: { r: 0, c: 0 }, v: 'from-legacy' }

    // The substrate engine drops a legacy op on the floor: no throw, no event,
    // no state change. Two users, two documents, one silence.
    expect(asSubstrateIngestable(sub)._ingestWire(legacyOp)).toBe(false)
    expect(sub.cells()).toEqual([{ r: 0, c: 0, v: 'from-substrate' }])

    // The legacy engine does worse: it reads `op.key.r` on an op that has no
    // `key`, and throws — from inside a fabric event listener, where it becomes
    // an uncaught console error per remote keystroke.
    expect(() => asLegacyIngestable(legacy)._ingestGridOp(substrateOp)).toThrow()

    legacy.destroy(); sub.destroy()
  })

  it('NOW: both sides detect it, refuse to replicate, and say so', async () => {
    const bus = new Bus()
    const fLegacy = new FakeFabric(bus, 'L')
    const fSub = new FakeFabric(bus, 'S')

    const legacyEvents: EngineMismatch[] = []
    const subEvents: EngineMismatch[] = []

    const legacy = new GridSession({ sessionId: 'mix', replicaId: 'L', fabricClient: asFabricClient(fLegacy) })
    legacy.addEventListener('engineMismatch', (e) => legacyEvents.push((e as CustomEvent<EngineMismatch>).detail))

    // Constructing the second session sends its hello, which the first sees.
    const sub = new SubstrateGridSession({ sessionId: 'mix', replicaId: 'S', fabricClient: asFabricClient(fSub) })
    sub.addEventListener('engineMismatch', (e) => subEvents.push((e as CustomEvent<EngineMismatch>).detail))

    // Both latched. The legacy peer learned from the substrate peer's opening
    // hello; the substrate peer learned from the legacy peer's reply.
    expect(legacy.engineMismatch).toMatchObject({
      local: ENGINE_LOCAL_LWW, remote: ENGINE_KOTVA_SYNC,
    })
    expect(sub.engineMismatch).toMatchObject({
      local: ENGINE_KOTVA_SYNC, remote: ENGINE_LOCAL_LWW,
    })
    // The `engineMismatch` event is deferred one microtask precisely so this
    // works: the substrate session latched INSIDE its own constructor (the
    // legacy peer answered its opening hello on a same-process transport), which
    // is before any caller could possibly have subscribed.
    await Promise.resolve()
    expect(legacyEvents).toHaveLength(1)
    expect(subEvents).toHaveLength(1)

    // And nothing further crosses in either direction.
    const legacySentBefore = fLegacy.sent.length
    const subSentBefore = fSub.sent.length
    legacy.setCell(0, 0, 'legacy-writes')
    sub.setCell(5, 5, 'substrate-writes')
    expect(fLegacy.sent.length).toBe(legacySentBefore)
    expect(fSub.sent.length).toBe(subSentBefore)

    // Local editing is untouched — that is the whole trade: visible loss of
    // collaboration instead of invisible loss of data.
    expect(legacy.cells()).toEqual([{ r: 0, c: 0, v: 'legacy-writes' }])
    expect(sub.cells()).toEqual([{ r: 5, c: 5, v: 'substrate-writes' }])

    legacy.destroy(); sub.destroy()
  })

  it('the substrate peer stops emitting localOp, so the update log stays single-engine', () => {
    const bus = new Bus()
    const sub = new SubstrateGridSession({
      sessionId: 'log', replicaId: 'S', fabricClient: asFabricClient(new FakeFabric(bus, 'S')),
    })
    const localOps: unknown[] = []
    sub.addEventListener('localOp', (e) => localOps.push((e as CustomEvent<GridLocalOpDetail>).detail.op))

    sub.setCell(0, 0, 'before')
    expect(localOps).toHaveLength(1)

    // A foreign frame arrives over the SAME durable log the mirror writes to.
    sub.applyLogOp({ kind: 1, id: '1_1_L', key: { r: 0, c: 0 }, v: 'foreign' })
    expect(sub.engineMismatch).not.toBeNull()

    sub.setCell(0, 1, 'after')
    expect(localOps).toHaveLength(1) // no new frame appended
    sub.destroy()
  })

  it('the legacy peer does the same on its log path', () => {
    const legacy = new GridSession({ sessionId: 'log2', replicaId: 'L', fabricClient: null })
    const localOps: unknown[] = []
    legacy.addEventListener('localOp', (e) => localOps.push((e as CustomEvent<GridLocalOpDetail>).detail.op))

    legacy.setCell(0, 0, 'before')
    expect(localOps).toHaveLength(1)

    expect(legacy.applyLogOp({ dsync: 1, b: 'AAEC' })).toBe(false)
    expect(legacy.engineMismatch).not.toBeNull()

    legacy.setCell(0, 1, 'after')
    expect(localOps).toHaveLength(1)
    legacy.destroy()
  })
})

// ---------------------------------------------------------------------------
// 4. The case an advertisement-only handshake would have missed.
// ---------------------------------------------------------------------------
describe('a peer on a bundle that predates the handshake (sends no hello at all)', () => {
  beforeAll(async () => { await initSubstrateSync() })

  it('is caught by op shape alone', async () => {
    // Deploy skew is the commonest mismatch there is: a tab loaded before the
    // operator flipped VITE_SUBSTRATE_SYNC is still open and still in the room.
    // It will never send `grid_hello`, so layer 1 cannot see it.
    const bus = new Bus()
    const fSub = new FakeFabric(bus, 'S')
    const sub = new SubstrateGridSession({ sessionId: 'old', replicaId: 'S', fabricClient: asFabricClient(fSub) })
    const events: EngineMismatch[] = []
    sub.addEventListener('engineMismatch', (e) => events.push((e as CustomEvent<EngineMismatch>).detail))

    // A raw old-bundle frame: correct type, correct session, no hello ever sent.
    const oldPeer = new FakeFabric(bus, 'OLD')
    oldPeer.send(JSON.stringify({
      type: 'grid_op', session: 'old',
      op: { kind: 1, id: '1_1_OLD', key: { r: 2, c: 3 }, v: 'ghost' },
    }))

    await Promise.resolve()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ remote: ENGINE_LOCAL_LWW, via: 'op-shape' })
    expect(sub.cells()).toEqual([]) // the op was refused, not applied
    sub.destroy()
  })

  it('and the same holds for its cold-join snapshot', () => {
    const bus = new Bus()
    const sub = new SubstrateGridSession({ sessionId: 'old2', replicaId: 'S', fabricClient: asFabricClient(new FakeFabric(bus, 'S')) })
    const oldPeer = new FakeFabric(bus, 'OLD')
    oldPeer.send(JSON.stringify({
      type: 'grid_snapshot', session: 'old2',
      cells: [{ r: 0, c: 0, opId: '1_1_OLD', value: 'ghost', deleted: false }],
    }))
    expect(sub.engineMismatch).toMatchObject({ remote: ENGINE_LOCAL_LWW, via: 'op-shape' })
    expect(sub.cells()).toEqual([])
    sub.destroy()
  })

  it('the legacy engine catches a hello-less substrate peer symmetrically', () => {
    const bus = new Bus()
    const legacy = new GridSession({ sessionId: 'old3', replicaId: 'L', fabricClient: asFabricClient(new FakeFabric(bus, 'L')) })
    const newPeer = new FakeFabric(bus, 'NEW')
    newPeer.send(JSON.stringify({
      type: 'grid_op', session: 'old3', op: { dsync: 1, b: 'AAECAwQ' },
    }))
    // Before this change that frame reached GridCRDT.apply and threw on
    // `op.key.r`; now it is refused before it can.
    expect(legacy.engineMismatch).toMatchObject({ remote: ENGINE_KOTVA_SYNC, via: 'op-shape' })
    legacy.destroy()
  })
})
