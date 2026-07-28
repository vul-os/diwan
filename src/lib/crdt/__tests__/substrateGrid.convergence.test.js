/**
 * substrateGrid.convergence.test.js — THE ADOPTION PROOF.
 *
 * The same test shape as `collab/__tests__/opLogSync.convergence.test.js` (two
 * clients diverge OFFLINE, both append to the shared server update log, reload
 * converges with nothing discarded), run against a Sheets grid whose CRDT is
 * the SHARED DMTAP Sync substrate engine instead of `crdt/grid.js`.
 *
 * Deliberately reusing that shape is the point: if the substrate could not
 * reproduce Diwan's behaviour under the tests Diwan already trusts, the honest
 * conclusion would be that it does not fit yet.
 *
 * The convergence assertion here is STRONGER than the one the hand-rolled path
 * can make. `grid.js` can only be compared through its rendered projection
 * (`cells()`); the substrate exposes `state_root()` — 33 content-addressed
 * bytes over the entire observable state (SYNC.md §6.1) — so "byte-identical
 * convergence" is asserted as literal byte equality, not inferred from a view.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { OpLogSync } from '../../collab/opLogSync.js'
import { createMemoryUpdateLog } from '../../collab/updateLog.js'
import { SubstrateGridSession, initSubstrateSync } from '../substrateGrid.js'

let n = 0
function uid(prefix) { return `${prefix}-${Date.now()}-${n++}` }

// The engine is WASM: load it once for the whole file, exactly as the editor
// loads it once before opening a session.
beforeAll(async () => { await initSubstrateSync() })

beforeEach(() => {
  try { localStorage.clear() } catch { /* no localStorage */ }
})

function gridAdapter(session) {
  return {
    subscribeLocal: (cb) => {
      const h = (e) => cb(e.detail.op)
      session.addEventListener('localOp', h)
      return () => session.removeEventListener('localOp', h)
    },
    applyOp: (op) => session.applyLogOp(op),
    applySnapshot: (snap) => session.applyLogSnapshot(snap),
    encodeSnapshot: () => session.logSnapshotData(),
  }
}

async function newGrid(log) {
  const s = new SubstrateGridSession({
    sessionId: uid('sgrid'), replicaId: uid('rep'), fabricClient: null,
  })
  const sync = new OpLogSync({ transport: log, ...gridAdapter(s), debounceMs: 0 })
  await sync.hydrate()
  return { s, sync }
}

function cellMap(session) {
  const out = {}
  for (const { r, c, v } of session.cells()) out[`${r},${c}`] = v
  return out
}

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function reloadGrid(log) {
  const { s, sync } = await newGrid(log)
  await sync.stop()
  return { cells: cellMap(s), root: hex(s.stateRoot()) }
}

describe('substrate grid convergence (Sheets on the shared engine)', () => {
  it('two clients diverge offline → both append → reload merges the union', async () => {
    const log = createMemoryUpdateLog()

    const A = await newGrid(log)
    const B = await newGrid(log)
    A.sync.start()
    B.sync.start()

    A.s.setCell(0, 0, 'A-shared')
    A.s.setCell(1, 0, 'A-only')
    B.s.setCell(0, 0, 'B-shared')
    B.s.setCell(0, 1, 'B-only')

    await A.sync.flush()
    await B.sync.flush()
    await A.sync.stop()
    await B.sync.stop()

    expect(log._debug().frames.length).toBe(2)

    const r1 = await reloadGrid(log)
    const r2 = await reloadGrid(log)

    // Byte-identical convergence: not just an equal projection, an equal ROOT.
    expect(r1.root).toBe(r2.root)
    expect(r1.cells).toEqual(r2.cells)

    // Non-conflicting edits both survive; the conflict has one winner.
    expect(r1.cells['1,0']).toBe('A-only')
    expect(r1.cells['0,1']).toBe('B-only')
    expect(['A-shared', 'B-shared']).toContain(r1.cells['0,0'])
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
    expect(dbg.frames.every((f) => f.seq > dbg.snapshot.floor)).toBe(true)

    const reloaded = await reloadGrid(log)
    expect(reloaded.cells).toEqual({ '0,0': 'x', '0,1': 'y', '1,1': 'z' })
  })

  it('a client editing AFTER a peer snapshot still converges', async () => {
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
    expect(reloaded.cells['0,0']).toBe('base')
    expect(reloaded.cells['5,5']).toBe('late')
  })

  it('a snapshot frame is COMPACTED to one op per cell, not the whole history', async () => {
    // The engine has no "load state" entry point — it is a fold over ops — so a
    // snapshot here is the minimal OP SET whose fold equals the state. For an
    // LWW register that is exactly one op per cell, however many times the cell
    // was overwritten. If this regressed, snapshots would grow without bound.
    const log = createMemoryUpdateLog()
    const { s, sync } = await newGrid(log)
    sync.start()
    for (let i = 0; i < 10; i++) s.setCell(0, 0, `v${i}`)
    s.setCell(9, 9, 'other')
    await sync.flush()
    await sync.stop()

    expect(s.logSnapshotData().length).toBe(2) // 11 ops → 2 surviving cells
    expect(cellMap(s)['0,0']).toBe('v9')
  })
})

describe('substrate grid semantics match the grid.js path', () => {
  it('clear hides a cell, and a LATER write revives it (LWW, not remove-wins)', async () => {
    // This is the reason clearCell maps to an lww-set of a tombstone tag and
    // NOT to the substrate's death certificate (SYNC.md §4.5). A death
    // certificate DOMINATES a later ordinary write, so the second edit below
    // would be silently swallowed — a regression against a working editor.
    const s = new SubstrateGridSession({
      sessionId: uid('sgrid'), replicaId: uid('rep'), fabricClient: null,
    })
    s.setCell(2, 3, 'hello')
    expect(cellMap(s)['2,3']).toBe('hello')

    s.clearCell(2, 3)
    expect(cellMap(s)['2,3']).toBeUndefined()

    s.setCell(2, 3, 'again')
    expect(cellMap(s)['2,3']).toBe('again')
  })

  it('an empty-string value is distinct from a cleared cell', async () => {
    const s = new SubstrateGridSession({
      sessionId: uid('sgrid'), replicaId: uid('rep'), fabricClient: null,
    })
    s.setCell(0, 0, '')
    s.setCell(0, 1, 'x')
    s.clearCell(0, 1)

    // ext-value (§4.1) has no null, so the two states are told apart by a value
    // tag. An untagged encoding would render a cleared cell as an empty one.
    expect(cellMap(s)['0,0']).toBe('')
    expect(Object.prototype.hasOwnProperty.call(cellMap(s), '0,0')).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(cellMap(s), '0,1')).toBe(false)
  })

  it('replaying the same op twice is idempotent (dedup by op-id)', async () => {
    const s = new SubstrateGridSession({
      sessionId: uid('sgrid'), replicaId: uid('rep'), fabricClient: null,
    })
    const ops = []
    s.addEventListener('localOp', (e) => ops.push(e.detail.op))
    s.setCell(1, 1, 'once')

    const before = hex(s.stateRoot())
    expect(s.applyLogOp(ops[0])).toBe(false) // already known
    expect(hex(s.stateRoot())).toBe(before)
  })

  it('a cold-joining replica does not lose its first edit to a stale clock', async () => {
    // The bug this pins is the one grid.js carries a DATA-INTEGRITY comment
    // about: a joiner that hydrates state without advancing its clock mints a
    // lower id than the cell already holds, and LWW drops the user's edit. The
    // substrate path must observe every hydrated op's HLC for the same reason.
    const log = createMemoryUpdateLog()
    const A = await newGrid(log)
    A.sync.start()
    A.s.setCell(4, 4, 'peer-value')
    await A.sync.flush()
    await A.sync.stop()

    const B = await newGrid(log) // hydrates A's op
    expect(cellMap(B.s)['4,4']).toBe('peer-value')
    B.s.setCell(4, 4, 'joiner-value') // must WIN — it is strictly later
    expect(cellMap(B.s)['4,4']).toBe('joiner-value')
  })

  it('two replicas that exchange every op reach an identical state root', async () => {
    const a = new SubstrateGridSession({
      sessionId: uid('sgrid'), replicaId: uid('repA'), fabricClient: null,
    })
    const b = new SubstrateGridSession({
      sessionId: uid('sgrid'), replicaId: uid('repB'), fabricClient: null,
    })
    const aOps = []; const bOps = []
    a.addEventListener('localOp', (e) => aOps.push(e.detail.op))
    b.addEventListener('localOp', (e) => bOps.push(e.detail.op))

    a.setCell(0, 0, 'a1'); a.setCell(0, 1, 'a2'); a.clearCell(0, 1)
    b.setCell(0, 0, 'b1'); b.setCell(1, 1, 'b2')

    // Deliver in DIFFERENT orders on each side — convergence must not depend on
    // arrival order (that is what makes it a CRDT).
    for (const op of bOps) a.applyLogOp(op)
    for (const op of [...aOps].reverse()) b.applyLogOp(op)

    expect(hex(a.stateRoot())).toBe(hex(b.stateRoot()))
    expect(cellMap(a)).toEqual(cellMap(b))
  })
})
