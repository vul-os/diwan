/**
 * chartsCrdt.test.js (WAVE-54)
 *
 * CRDT round-trip of chart objects over GridSession's fabric stream. A chart is
 * plain data; upsert/remove broadcast a `chart_op` that a peer surfaces as a
 * 'remoteOp' event carrying the descriptor to merge. Verifies the descriptor
 * arrives intact (round-trips) and delete propagates.
 */
import { describe, it, expect, vi } from 'vitest'
import { GridSession } from '../../lib/crdt/grid.js'
import { makeChart } from './charts.js'
import type { FabricClient } from '../../lib/collab/webrtc/fabric.js'
import type { ChartDescriptor } from '../../lib/crdt/grid.js'

/** The 'remoteOp' detail shape grid.ts dispatches for a chart_op (see grid.ts's
 * `else if (msg.type === 'chart_op')` branch). */
type ChartOpDetail = { chart?: ChartDescriptor; chartId?: string; action?: string; opId?: string }

// Minimal in-process fabric matching what GridSession consumes:
//   .send(str)         → broadcast to the other node
//   'message' event    → { detail: { data: str } }
// Only exercises the addEventListener/send surface GridSession actually calls
// on its transport (see grid.ts) — the cast to the real FabricClient type below
// is the same kind production itself does for its own transport casts.
class PairFabric extends EventTarget {
  peer: PairFabric | null
  constructor() { super(); this.peer = null }
  link(other: PairFabric) { this.peer = other; other.peer = this }
  send(frame: string) { if (this.peer) queueMicrotask(() => this.peer!.dispatchEvent(new CustomEvent('message', { detail: { data: frame } }))) }
}

const asFabricClient = (f: PairFabric): FabricClient => f as unknown as FabricClient

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('chart CRDT round-trip', () => {
  it('upsert propagates the full descriptor to a peer, intact', async () => {
    const a = new PairFabric(), b = new PairFabric()
    a.link(b)
    const s1 = new GridSession({ sessionId: 'doc1', replicaId: 'r1', fabricClient: asFabricClient(a) })
    const s2 = new GridSession({ sessionId: 'doc1', replicaId: 'r2', fabricClient: asFabricClient(b) })

    const received: ChartOpDetail[] = []
    s2.addEventListener('remoteOp', (ev) => {
      const detail = (ev as CustomEvent).detail as ChartOpDetail
      if (detail?.chart) received.push(detail)
    })

    const chart = makeChart({ id: 'c1', type: 'pie', range: 'A1:B5', title: 'Share', x: 12, y: 34, w: 400, h: 260 })
    // Chart (charts.ts) has no index signature; ChartDescriptor (grid.ts) is the
    // wire-op's looser "plain data with an id" contract the two modules share.
    s1.upsertChart(chart as unknown as ChartDescriptor)
    await flush()

    expect(received).toHaveLength(1)
    expect(received[0].action).toBe('upsert')
    // Full descriptor round-tripped byte-for-byte (JSON-equal).
    expect(received[0].chart).toEqual(chart)

    s1.destroy(); s2.destroy()
  })

  it('delete propagates a chartId to the peer', async () => {
    const a = new PairFabric(), b = new PairFabric()
    a.link(b)
    const s1 = new GridSession({ sessionId: 'doc2', replicaId: 'r1', fabricClient: asFabricClient(a) })
    const s2 = new GridSession({ sessionId: 'doc2', replicaId: 'r2', fabricClient: asFabricClient(b) })

    const events: ChartOpDetail[] = []
    s2.addEventListener('remoteOp', (ev) => {
      const detail = (ev as CustomEvent).detail as ChartOpDetail
      if (detail?.chartId || detail?.chart) events.push(detail)
    })

    s1.removeChart('c9')
    await flush()

    expect(events).toHaveLength(1)
    expect(events[0].action).toBe('delete')
    expect(events[0].chartId).toBe('c9')

    s1.destroy(); s2.destroy()
  })

  it('ignores malformed chart upserts (no id) — never broadcasts', async () => {
    const a = new PairFabric(), b = new PairFabric()
    a.link(b)
    const s1 = new GridSession({ sessionId: 'doc3', replicaId: 'r1', fabricClient: asFabricClient(a) })
    const s2 = new GridSession({ sessionId: 'doc3', replicaId: 'r2', fabricClient: asFabricClient(b) })
    const spy = vi.fn()
    s2.addEventListener('remoteOp', spy)
    // Deliberately malformed input (no `id`) — upsertChart must reject it
    // fail-closed, so the cast documents intent rather than widening the API.
    s1.upsertChart({ /* no id */ type: 'bar' } as unknown as ChartDescriptor)
    await flush()
    expect(spy).not.toHaveBeenCalled()
    s1.destroy(); s2.destroy()
  })
})
