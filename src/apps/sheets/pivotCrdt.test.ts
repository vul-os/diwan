/**
 * pivotCrdt.test.js  (WAVE-63)
 *
 * CRDT round-trip + INGRESS-VALIDATION for reactive pivot descriptors, mirroring
 * chartsCrdt.test.js. A pivot is plain data; upsert/remove broadcast a
 * `pivot_op` that a peer surfaces as a 'remoteOp' event. Crucially, a peer must
 * NEVER merge the raw descriptor — the SheetsEditor ingress runs it through
 * makePivot (allow-listed agg, coerced/capped strings, normalised range). These
 * tests prove the transport round-trips AND that makePivot clamps a hostile
 * descriptor fail-closed (no unbounded fields, no non-string React children).
 */
import { describe, it, expect, vi } from 'vitest'
import { GridSession } from '../../lib/crdt/grid.js'
import { makePivot } from './pivot.js'
import type { FabricClient } from '../../lib/collab/webrtc/fabric.js'
import type { PivotDescriptor } from '../../lib/crdt/grid.js'

/** The 'remoteOp' detail shape grid.ts dispatches for a pivot_op. */
type PivotOpDetail = { pivot?: PivotDescriptor; pivotId?: string; pivotAction?: string; opId?: string }

class PairFabric extends EventTarget {
  peer: PairFabric | null
  constructor() { super(); this.peer = null }
  link(other: PairFabric) { this.peer = other; other.peer = this }
  send(frame: string) { if (this.peer) queueMicrotask(() => this.peer!.dispatchEvent(new CustomEvent('message', { detail: { data: frame } }))) }
}

const asFabricClient = (f: PairFabric): FabricClient => f as unknown as FabricClient

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('pivot CRDT round-trip', () => {
  it('upsert propagates the full descriptor to a peer, intact', async () => {
    const a = new PairFabric(), b = new PairFabric(); a.link(b)
    const s1 = new GridSession({ sessionId: 'p-doc1', replicaId: 'r1', fabricClient: asFabricClient(a) })
    const s2 = new GridSession({ sessionId: 'p-doc1', replicaId: 'r2', fabricClient: asFabricClient(b) })
    const received: PivotOpDetail[] = []
    s2.addEventListener('remoteOp', (ev) => {
      const detail = (ev as CustomEvent).detail as PivotOpDetail
      if (detail?.pivot) received.push(detail)
    })

    const pivot = makePivot({ id: 'pv1', range: 'A1:D50', rowField: 'Region', valueField: 'Sales', agg: 'AVG', title: 'By region' })
    s1.upsertPivot(pivot as unknown as PivotDescriptor)
    await flush()

    expect(received).toHaveLength(1)
    expect(received[0].pivotAction).toBe('upsert')
    expect(received[0].pivot).toEqual(pivot)
    s1.destroy(); s2.destroy()
  })

  it('delete propagates a pivotId to the peer', async () => {
    const a = new PairFabric(), b = new PairFabric(); a.link(b)
    const s1 = new GridSession({ sessionId: 'p-doc2', replicaId: 'r1', fabricClient: asFabricClient(a) })
    const s2 = new GridSession({ sessionId: 'p-doc2', replicaId: 'r2', fabricClient: asFabricClient(b) })
    const events: PivotOpDetail[] = []
    s2.addEventListener('remoteOp', (ev) => {
      const detail = (ev as CustomEvent).detail as PivotOpDetail
      if (detail?.pivotId || detail?.pivot) events.push(detail)
    })

    s1.removePivot('pv9')
    await flush()
    expect(events).toHaveLength(1)
    expect(events[0].pivotAction).toBe('delete')
    expect(events[0].pivotId).toBe('pv9')
    s1.destroy(); s2.destroy()
  })

  it('ignores malformed pivot upserts (no id) — never broadcasts', async () => {
    const a = new PairFabric(), b = new PairFabric(); a.link(b)
    const s1 = new GridSession({ sessionId: 'p-doc3', replicaId: 'r1', fabricClient: asFabricClient(a) })
    const s2 = new GridSession({ sessionId: 'p-doc3', replicaId: 'r2', fabricClient: asFabricClient(b) })
    const spy = vi.fn()
    s2.addEventListener('remoteOp', spy)
    // Deliberately malformed input (no `id`) — upsertPivot must reject it
    // fail-closed, so the cast documents intent rather than widening the API.
    s1.upsertPivot({ /* no id */ agg: 'SUM' } as unknown as PivotDescriptor)
    await flush()
    expect(spy).not.toHaveBeenCalled()
    s1.destroy(); s2.destroy()
  })
})

describe('pivot INGRESS validation (fail-closed clamp at the receiver)', () => {
  // Simulate the SheetsEditor onRemote ingress: whatever a hostile peer sends,
  // the receiver clamps via makePivot before it can reach the model/render.
  function ingest(rawDescriptor: unknown) {
    return makePivot(rawDescriptor as Parameters<typeof makePivot>[0])
  }

  it('drops an unknown aggregation → SUM (no arbitrary agg executed)', () => {
    const safe = ingest({ id: 'x', agg: 'process.exit', range: 'A1:B2' })
    expect(safe.agg).toBe('SUM')
  })

  it('coerces a non-string title/field → empty (blocks React-child crash)', () => {
    const hostile = { id: 'x', title: { toString() { throw new Error('boom') } }, rowField: [1, 2], valueField: {} }
    const safe = ingest(hostile)
    expect(typeof safe.title).toBe('string')
    expect(safe.title).toBe('')
    expect(safe.rowField).toBe('')
    expect(safe.valueField).toBe('')
  })

  it('caps absurdly long strings (no unbounded memory)', () => {
    const safe = ingest({ id: 'x', title: 'A'.repeat(1e6), range: 'B'.repeat(1e6) })
    expect(safe.title.length).toBeLessThanOrEqual(200)
    expect(safe.range.length).toBeLessThanOrEqual(40)
  })

  it('clamps non-finite / out-of-bounds card position (no NaN layout)', () => {
    const safe = ingest({ id: 'x', x: NaN, y: Infinity })
    expect(Number.isFinite(safe.x) && Number.isFinite(safe.y)).toBe(true)
    const clamped = ingest({ id: 'y', x: -1e9, y: 1e12 })
    expect(clamped.x).toBe(0)
    expect(clamped.y).toBe(100000)
  })

  it('result is JSON-serialisable (safe to re-broadcast / persist)', () => {
    const safe = ingest({ id: 'x', agg: 'MAX', range: 'a1:c9', rowField: 'r', valueField: 'v' })
    expect(JSON.parse(JSON.stringify(safe))).toEqual(safe)
  })
})
