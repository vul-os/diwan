/**
 * CRDT-native persistence, phase 2 — convergence for the OP-BASED CRDTs.
 *
 * The op-based sibling of updateLog.convergence.test.js: two clients that
 * diverge OFFLINE (Sheets grid / Slides tree), each append their own ops to the
 * shared server update log, and on reload the document converges with NOTHING
 * discarded. These drive the EXACT in-memory contract the Go store implements
 * (createMemoryUpdateLog), through the real OpLogSync client and the real
 * GridSession / TreeSession CRDTs.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { OpLogSync, type OpLogSyncOptions } from '../opLogSync.js'
import { createMemoryUpdateLog, type UpdateLogTransportError } from '../updateLog.js'
import { GridSession, type GridLocalOpDetail } from '../../crdt/grid.js'
import { TreeSession, ordKeyBetween, type TreeLocalOpDetail } from '../../crdt/tree.js'

// A fresh, unique session/replica id per call so localStorage (jsdom) and LWW
// opIds never collide across sessions or tests.
let n = 0
function uid(prefix: string): string { return `${prefix}-${Date.now()}-${n++}` }

beforeEach(() => {
  try { localStorage.clear() } catch { /* no localStorage */ }
})

type LogAdapter = Pick<OpLogSyncOptions, 'subscribeLocal' | 'applyOp' | 'applySnapshot' | 'encodeSnapshot'>

function gridAdapter(session: GridSession): LogAdapter {
  return {
    subscribeLocal: (cb) => {
      const h = (e: Event) => cb((e as CustomEvent<GridLocalOpDetail>).detail.op)
      session.addEventListener('localOp', h)
      return () => session.removeEventListener('localOp', h)
    },
    applyOp: (op) => session.applyLogOp(op),
    applySnapshot: (snap) => session.applyLogSnapshot(snap),
    encodeSnapshot: () => session.logSnapshotData(),
  }
}

function treeAdapter(session: TreeSession): LogAdapter {
  return {
    subscribeLocal: (cb) => {
      const h = (e: Event) => cb((e as CustomEvent<TreeLocalOpDetail>).detail.op)
      session.addEventListener('localOp', h)
      return () => session.removeEventListener('localOp', h)
    },
    applyOp: (op) => session.applyLogOp(op),
    applySnapshot: (snap) => session.applyLogSnapshot(snap),
    encodeSnapshot: () => session.logSnapshotData(),
  }
}

async function newGrid(log: OpLogSyncOptions['transport']): Promise<{ s: GridSession, sync: OpLogSync }> {
  const s = new GridSession({ sessionId: uid('grid'), replicaId: uid('rep'), fabricClient: null })
  const sync = new OpLogSync({ transport: log, ...gridAdapter(s), debounceMs: 0 })
  await sync.hydrate()
  return { s, sync }
}

async function reloadGrid(log: OpLogSyncOptions['transport']): Promise<Record<string, string>> {
  const { s, sync } = await newGrid(log)
  await sync.stop()
  // Return sorted cell map for comparison.
  const out: Record<string, string> = {}
  for (const { r, c, v } of s.cells()) out[`${r},${c}`] = v
  return out
}

describe('OpLogSync grid convergence (Sheets)', () => {
  it('two clients diverge offline → both append → reload merges the union', async () => {
    const log = createMemoryUpdateLog()

    const A = await newGrid(log)
    const B = await newGrid(log)
    A.sync.start()
    B.sync.start()

    // Divergent offline edits to DIFFERENT cells (both must survive) plus a
    // conflicting edit to the SAME cell (deterministic LWW).
    A.s.setCell(0, 0, 'A-shared')
    A.s.setCell(1, 0, 'A-only')
    B.s.setCell(0, 0, 'B-shared')
    B.s.setCell(0, 1, 'B-only')

    await A.sync.flush()
    await B.sync.flush()
    await A.sync.stop()
    await B.sync.stop()

    // Two update frames landed (one batch per client), nothing lost.
    expect(log._debug().frames.length).toBe(2)

    const r1 = await reloadGrid(log)
    const r2 = await reloadGrid(log)

    // Both fresh reloads converge to the SAME state.
    expect(r1).toEqual(r2)
    // The non-conflicting edits both survive.
    expect(r1['1,0']).toBe('A-only')
    expect(r1['0,1']).toBe('B-only')
    // The conflicting cell resolves to exactly one deterministic winner.
    expect(['A-shared', 'B-shared']).toContain(r1['0,0'])
  })

  it('converges after snapshot compaction (frames pruned, snapshot + tail replays)', async () => {
    const log = createMemoryUpdateLog()

    const A = await newGrid(log)
    A.sync.start()
    A.s.setCell(0, 0, 'x')
    await A.sync.flush()
    A.s.setCell(0, 1, 'y')
    await A.sync.flush()
    await A.sync.snapshot() // compact — earlier frames pruned
    A.s.setCell(1, 1, 'z') // an edit ABOVE the snapshot floor
    await A.sync.flush()
    await A.sync.stop()

    const dbg = log._debug()
    expect(dbg.snapshot).not.toBeNull()
    const snapshotFloor = dbg.snapshot!.floor
    expect(dbg.frames.every((f) => f.seq > snapshotFloor!)).toBe(true)

    const reloaded = await reloadGrid(log)
    expect(reloaded).toEqual({ '0,0': 'x', '0,1': 'y', '1,1': 'z' })
  })

  it('a client editing AFTER a peer snapshot still converges (frame above floor preserved)', async () => {
    const log = createMemoryUpdateLog()

    const A = await newGrid(log)
    A.sync.start()
    A.s.setCell(0, 0, 'base')
    await A.sync.flush()
    await A.sync.snapshot()

    const B = await newGrid(log) // loads the snapshot
    B.sync.start()
    B.s.setCell(5, 5, 'late')
    await B.sync.flush()
    await A.sync.stop()
    await B.sync.stop()

    const reloaded = await reloadGrid(log)
    expect(reloaded['0,0']).toBe('base')
    expect(reloaded['5,5']).toBe('late')
  })
})

async function newTree(log: OpLogSyncOptions['transport']): Promise<{ s: TreeSession, sync: OpLogSync }> {
  const s = new TreeSession({ sessionId: uid('tree'), replicaId: uid('rep'), fabricClient: null })
  const sync = new OpLogSync({ transport: log, ...treeAdapter(s), debounceMs: 0 })
  await sync.hydrate()
  return { s, sync }
}

async function reloadTreeTitles(log: OpLogSyncOptions['transport']): Promise<string[]> {
  const { s, sync } = await newTree(log)
  await sync.stop()
  return s.orderedSlides().map(({ data }) => (data as { title: string }).title)
}

describe('OpLogSync tree convergence (Slides)', () => {
  it('two clients insert slides offline → both append → reload keeps both', async () => {
    const log = createMemoryUpdateLog()

    const A = await newTree(log)
    const B = await newTree(log)
    A.sync.start()
    B.sync.start()

    A.s.insertSlide(ordKeyBetween('a', 'm'), { title: 'A-slide', objects: [] })
    B.s.insertSlide(ordKeyBetween('m', 'z'), { title: 'B-slide', objects: [] })

    await A.sync.flush()
    await B.sync.flush()
    await A.sync.stop()
    await B.sync.stop()

    const t1 = await reloadTreeTitles(log)
    const t2 = await reloadTreeTitles(log)
    expect(t1).toEqual(t2)
    expect(t1).toContain('A-slide')
    expect(t1).toContain('B-slide')
  })

  it('a concurrent per-object edit and a title edit on one slide both survive', async () => {
    const log = createMemoryUpdateLog()

    // Seed one slide via client A and snapshot so B loads it.
    const A = await newTree(log)
    A.sync.start()
    const nodeId = A.s.insertSlide('m', { title: 'orig', objects: [{ id: 'o1', text: 'one' }] })
    await A.sync.flush()
    await A.sync.snapshot()

    const B = await newTree(log)
    B.sync.start()

    // A edits object o1; B edits the title — different sub-parts of one slide.
    A.s.setSlide(nodeId, { title: 'orig', objects: [{ id: 'o1', text: 'EDITED' }] })
    B.s.setSlide(nodeId, { title: 'B-TITLE', objects: [{ id: 'o1', text: 'one' }] })

    await A.sync.flush()
    await B.sync.flush()
    await A.sync.stop()
    await B.sync.stop()

    const { s, sync } = await newTree(log)
    await sync.stop()
    const slide = s.orderedSlides()[0].data
    // Object edit from A and title edit from B both survive (object-granular LWW).
    expect(slide.title).toBe('B-TITLE')
    const editedObj = (slide.objects ?? []).find((o) => o.id === 'o1') as { id: string, text: string } | undefined
    expect(editedObj?.text).toBe('EDITED')
  })

  it('hydrate disables cleanly when the server has no update log (404)', async () => {
    const failing: OpLogSyncOptions['transport'] = {
      // No await needed: both throw synchronously, and opLogSync.ts's own
      // `await this._t.load(0)` / `await this._t.append(...)` call sites are
      // already inside a try/catch, so the exception lands in the same place
      // whether it arrives via a rejected Promise or a synchronous throw.
      load: () => { const e: UpdateLogTransportError = new Error('not found'); e.status = 404; throw e },
      append: () => { throw new Error('should not be called') },
    }
    const s = new GridSession({ sessionId: uid('grid'), replicaId: uid('rep'), fabricClient: null })
    const sync = new OpLogSync({ transport: failing, ...gridAdapter(s), debounceMs: 0 })
    const ok = await sync.hydrate()
    expect(ok).toBe(false)
    expect(sync.enabled).toBe(false)
    sync.start()
    s.setCell(0, 0, 'x')
    await sync.flush() // must not throw / must not call append
  })
})
