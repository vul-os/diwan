/**
 * convergence.regression.test.js — data-integrity regression guards for the
 * Office CRDTs (deep/office audit).
 *
 * Each block pins a CONFIRMED bug that corrupted a user's document or made two
 * peers diverge. They failed before the deep/office fixes and must stay green.
 *
 * WHY BUG1, BUG2, BUG3 AND BUG6 ARE NO LONGER HERE. They guarded the hand-rolled
 * text RGA (`crdt/text.js`) and the sessions built on it (`crdt/index.js`,
 * `crdt/p2pSession.js`). That cluster was deleted, not fixed-and-forgotten: Docs
 * has run on Yjs + y-prosemirror since the plain-text sync path was retired, and
 * nothing in the shipping app constructed a `TextCRDT` any more. The bugs those
 * blocks pinned (a clock unseeded by restore, a diff splitting astral
 * characters, a delete arriving before its insert, a snapshot exchange that
 * replaced instead of merged) are all properties of that RGA, and none of them
 * can recur in an engine that no longer exists. The Yjs path's equivalents —
 * structure/formatting crossing intact, offline-then-reconnect converging by
 * union, a read-only peer being unable to write — are covered against the LIVE
 * engine in `yP2PSession.test.js` and `yP2PSession.multipeer.test.js`.
 *
 * The numbering is left with gaps on purpose. Renumbering would detach these
 * blocks from the audit that named them.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { GridSession } from '../grid.js'
import { TreeSession, type TreeNodeSnapshot, type Slide } from '../tree.js'
import type { FabricClient } from '../../collab/webrtc/fabric.js'

// Minimal in-process fabric so sessions build without touching the network.
class FakeFabric extends EventTarget {
  sent: string[]
  constructor() { super(); this.sent = [] }
  async join() {}
  send(f: string) { this.sent.push(f) }
  sendTo() {}
  leave() {}
}

// GridSession/TreeSession only ever call addEventListener/send/removeEventListener
// on their transport (see grid.ts / tree.ts) — FakeFabric and the ad-hoc
// EventTarget subclasses below satisfy that at runtime; the cast to the real
// FabricClient type is the same kind of transport cast production itself makes.
const asFabricClient = (f: EventTarget): FabricClient => f as unknown as FabricClient

// `_crdt`/`_handleFabricMessage` are private implementation details of
// TreeSession; several of these regression pins need to drive the CRDT and the
// wire handler directly to reproduce a cold-join/reconnect exactly. Same
// reach-past-privacy cast as yP2PSession.test.ts's `asBroadcaster`.
type TreeInternals = {
  _crdt: { snapshot(): TreeNodeSnapshot[] }
  _handleFabricMessage(raw: unknown): void
}
const internals = (s: TreeSession): TreeInternals => s as unknown as TreeInternals

// ---------------------------------------------------------------------------
// BUG 4 — GridSession cold-join over the fabric applied a peer snapshot's cells
// but did NOT advance the local Lamport clock past their counters. The joiner's
// first edits then minted smaller OpIDs than the cells already held; LWW
// (higher OpID wins) DROPPED those edits, so the user typed a value that
// silently reverted to the peer's.
// ---------------------------------------------------------------------------
describe('BUG4: grid cold-join seeds the clock (joiner edits win)', () => {
  beforeEach(() => { try { localStorage.clear(); sessionStorage.clear() } catch { /* jsdom */ } })

  function highOpId(counter: number, replica: string): string {
    return '0'.repeat(20) + '_' + String(counter).padStart(10, '0') + '_' + replica
  }

  it('an edit to an existing cell after a snapshot merge is not dropped', () => {
    const fab = new FakeFabric()
    const s = new GridSession({ sessionId: 'sheet1', replicaId: 'joiner', fabricClient: asFabricClient(fab) })
    fab.dispatchEvent(new CustomEvent('message', {
      detail: { data: JSON.stringify({
        type: 'grid_snapshot', session: 'sheet1',
        cells: [{ r: 0, c: 0, opId: highOpId(50, 'peerA'), value: 'peerval', deleted: false }],
      }) },
    }))
    expect(s.cells()).toEqual([{ r: 0, c: 0, v: 'peerval' }])

    s.setCell(0, 0, 'myval')
    expect(s.cells()).toEqual([{ r: 0, c: 0, v: 'myval' }]) // was still 'peerval'
  })
})

// ---------------------------------------------------------------------------
// BUG 5 — TreeSession cold-join (Slides) had the same defect as the grid: it
// merged a peer's snapshot nodes without advancing the Lamport clock, so the
// joiner's first setSlide/moveSlide minted a lower OpID than the node already
// held and the LWW guard DROPPED the edit — a slide text change or reorder
// silently reverted to the peer's version.
// ---------------------------------------------------------------------------
describe('BUG5: slides tree cold-join seeds the clock (joiner edits win)', () => {
  beforeEach(() => { try { localStorage.clear(); sessionStorage.clear() } catch { /* jsdom */ } })

  function id(counter: number, replica: string): string {
    return '0'.repeat(20) + '_' + String(counter).padStart(10, '0') + '_' + replica
  }

  it('editing an existing slide after a snapshot merge is not dropped', () => {
    const fab = new FakeFabric()
    const s = new TreeSession({ sessionId: 'deck1', replicaId: 'joiner', fabricClient: asFabricClient(fab) })
    const nodeId = id(10, 'peerA')
    fab.dispatchEvent(new CustomEvent('message', {
      detail: { data: JSON.stringify({
        type: 'tree_snapshot', session: 'deck1',
        nodes: [{
          id: nodeId, parent: '', ordKey: 'm', ordId: nodeId,
          value: JSON.stringify({ title: 'peer' }), valueId: id(20, 'peerA'), deleted: false,
        }],
      }) },
    }))
    expect(s.orderedSlides()).toHaveLength(1)

    s.setSlide(nodeId, { title: 'mine' })
    expect(s.orderedSlides()[0].data).toEqual({ title: 'mine' }) // was still {title:'peer'}
  })
})

// BUG 8 (fix/office-collab-autosave, P1) — Slides SLIDE-LEVEL clobber.
//
// A slide was stored as ONE JSON blob mutated via a whole-slide LWW (SET_TEXT).
// Two peers editing DIFFERENT positioned objects on the SAME slide clobbered
// each other: last-writer-wins on the ENTIRE slide → the loser's object move/
// edit was silently lost. Fix: per-OBJECT LWW — each object carries its own id +
// opId and setSlide diffs + broadcasts only the changed objects/scalars, merged
// per-entry. Two peers moving two different objects must BOTH survive; two peers
// editing the SAME object is deterministic per-object LWW; scalar props keep
// their own LWW stamp.
// ---------------------------------------------------------------------------
describe('BUG8: slides per-object LWW (concurrent object edits both survive)', () => {
  beforeEach(() => { try { localStorage.clear(); sessionStorage.clear() } catch { /* jsdom */ } })

  // Two TreeSessions on a shared bus, but each captures outbound frames so the
  // test controls delivery timing. `flush()` cross-delivers all queued frames —
  // this models TRUE concurrency: both peers act BEFORE seeing each other's op,
  // exactly the case a whole-slide LWW clobbered. Seeded from a common base deck.
  function concurrentPair(session: string, baseSlide: Slide) {
    const seed = new TreeSession({ sessionId: session, replicaId: 'seed', fabricClient: asFabricClient(new (class extends EventTarget { send() {} })()) })
    const nid = seed.insertSlide('m', baseSlide)
    const baseNodes = internals(seed)._crdt.snapshot()

    const queues = new Map<string, string[]>()
    const mk = (replicaId: string): TreeSession => {
      const fab = new (class extends EventTarget { send(frame: string) { queues.get(replicaId)!.push(frame) } })()
      const s = new TreeSession({ sessionId: session, replicaId, fabricClient: asFabricClient(fab) })
      queues.set(replicaId, [])
      internals(s)._handleFabricMessage(JSON.stringify({ type: 'tree_snapshot', session, nodes: baseNodes }))
      queues.set(replicaId, []) // discard any frames from the seed apply
      return s
    }
    const A = mk('A'), B = mk('B')
    const flush = () => {
      const fa = queues.get('A')!.splice(0), fb = queues.get('B')!.splice(0)
      for (const f of fa) internals(B)._handleFabricMessage(f)   // A's ops → B
      for (const f of fb) internals(A)._handleFabricMessage(f)   // B's ops → A
    }
    return { A, B, nid, flush }
  }

  function slideOf(s: TreeSession, nodeId: string): Slide {
    return s.orderedSlides().find((x) => x.nodeId === nodeId)!.data
  }

  it('two peers moving DIFFERENT objects on one slide → union (no loss)', () => {
    const { A, B, nid, flush } = concurrentPair('deck1', {
      title: 'S',
      objects: [
        { id: 'o1', type: 'shape', x: 0.1, y: 0.1, w: 0.2, h: 0.2, z: 1 },
        { id: 'o2', type: 'shape', x: 0.5, y: 0.5, w: 0.2, h: 0.2, z: 2 },
      ],
    })
    // TRUE concurrency: each acts against the base BEFORE seeing the other.
    A.setSlide(nid, {
      title: 'S',
      objects: [
        { id: 'o1', type: 'shape', x: 0.8, y: 0.8, w: 0.2, h: 0.2, z: 1 }, // A moves o1
        { id: 'o2', type: 'shape', x: 0.5, y: 0.5, w: 0.2, h: 0.2, z: 2 },
      ],
    })
    B.setSlide(nid, {
      title: 'S',
      objects: [
        { id: 'o1', type: 'shape', x: 0.1, y: 0.1, w: 0.2, h: 0.2, z: 1 },
        { id: 'o2', type: 'shape', x: 0.2, y: 0.2, w: 0.2, h: 0.2, z: 2 }, // B moves o2
      ],
    })
    flush()

    for (const s of [A, B]) {
      const objs = Object.fromEntries(slideOf(s, nid).objects!.map((o) => [o.id!, o])) as Record<string, { x?: number }>
      expect(objs.o1.x).toBe(0.8) // A's move to o1 survived on both
      expect(objs.o2.x).toBe(0.2) // B's move to o2 survived on both — NOT clobbered
    }
    expect(slideOf(A, nid)).toEqual(slideOf(B, nid))
  })

  it('two peers editing the SAME object → deterministic per-object LWW', () => {
    const { A, B, nid, flush } = concurrentPair('deck2', {
      objects: [{ id: 'o1', type: 'shape', x: 0, y: 0, w: 0.2, h: 0.2, z: 1 }],
    })
    A.setSlide(nid, { objects: [{ id: 'o1', type: 'shape', x: 0.3, y: 0, w: 0.2, h: 0.2, z: 1 }] })
    B.setSlide(nid, { objects: [{ id: 'o1', type: 'shape', x: 0.7, y: 0, w: 0.2, h: 0.2, z: 1 }] })
    flush()

    // Both replicas agree on the SAME winner (higher opId wins — deterministic).
    expect(slideOf(A, nid)).toEqual(slideOf(B, nid))
    expect([0.3, 0.7]).toContain(slideOf(A, nid).objects![0].x)
  })

  it('scalar props (background) keep their own LWW, independent of objects', () => {
    const { A, B, nid, flush } = concurrentPair('deck3', {
      background: '#000', objects: [{ id: 'o1', type: 'shape', x: 0, y: 0, w: 0.2, h: 0.2, z: 1 }],
    })
    A.setSlide(nid, { background: '#fff', objects: [{ id: 'o1', type: 'shape', x: 0, y: 0, w: 0.2, h: 0.2, z: 1 }] })
    B.setSlide(nid, { background: '#000', objects: [{ id: 'o1', type: 'shape', x: 0.5, y: 0, w: 0.2, h: 0.2, z: 1 }] })
    flush()

    for (const s of [A, B]) {
      const d = slideOf(s, nid)
      expect(d.background).toBe('#fff')      // A's scalar edit survived
      expect(d.objects![0].x).toBe(0.5)       // B's object move survived (independent)
    }
  })

  it('a peer DELETING an object converges (object removed on both)', () => {
    const { A, B, nid, flush } = concurrentPair('deck4', {
      objects: [
        { id: 'o1', type: 'shape', x: 0, y: 0, w: 0.2, h: 0.2, z: 1 },
        { id: 'o2', type: 'shape', x: 0.5, y: 0, w: 0.2, h: 0.2, z: 2 },
      ],
    })
    A.setSlide(nid, {
      objects: [
        { id: 'o1', type: 'shape', x: 0.9, y: 0, w: 0.2, h: 0.2, z: 1 }, // A moves o1
        { id: 'o2', type: 'shape', x: 0.5, y: 0, w: 0.2, h: 0.2, z: 2 },
      ],
    })
    B.setSlide(nid, { objects: [{ id: 'o1', type: 'shape', x: 0, y: 0, w: 0.2, h: 0.2, z: 1 }] }) // B deletes o2
    flush()

    for (const s of [A, B]) {
      const objs = slideOf(s, nid).objects!
      expect(objs.map((o) => o.id)).toEqual(['o1']) // o2 deleted on both
      expect(objs[0].x).toBe(0.9)                   // A's move to o1 survived
    }
  })
})

// ---------------------------------------------------------------------------
// BUG 9 (fix/office-collab-autosave, P1) — offline-reconnect of slides must
// converge object-granularly. Two peers edit DIFFERENT objects OFFLINE, then
// exchange snapshots on reconnect. A whole-slide-replay cold-join would clobber
// the joiner's own concurrent object edit; the union merge keeps both.
// ---------------------------------------------------------------------------
describe('BUG9: slides offline-reconnect converges per object (no lost edits)', () => {
  beforeEach(() => { try { localStorage.clear(); sessionStorage.clear() } catch { /* jsdom */ } })
  class FF extends EventTarget { send() {} }

  it('offline edits to different objects both survive a snapshot exchange', () => {
    // Shared starting deck (same node id + objects on both replicas).
    const seed = new TreeSession({ sessionId: 'deckR', replicaId: 'seed', fabricClient: asFabricClient(new FF()) })
    const nid = seed.insertSlide('m', {
      objects: [
        { id: 'o1', type: 'shape', x: 0.1, y: 0, w: 0.2, h: 0.2, z: 1 },
        { id: 'o2', type: 'shape', x: 0.5, y: 0, w: 0.2, h: 0.2, z: 2 },
      ],
    })
    const baseNodes = internals(seed)._crdt.snapshot()

    const A = new TreeSession({ sessionId: 'deckR', replicaId: 'A', fabricClient: asFabricClient(new FF()) })
    const B = new TreeSession({ sessionId: 'deckR', replicaId: 'B', fabricClient: asFabricClient(new FF()) })
    for (const s of [A, B]) {
      internals(s)._handleFabricMessage(JSON.stringify({ type: 'tree_snapshot', session: 'deckR', nodes: baseNodes }))
    }

    // OFFLINE: A moves o1, B moves o2 — neither sees the other yet.
    A.setSlide(nid, {
      objects: [
        { id: 'o1', type: 'shape', x: 0.9, y: 0, w: 0.2, h: 0.2, z: 1 },
        { id: 'o2', type: 'shape', x: 0.5, y: 0, w: 0.2, h: 0.2, z: 2 },
      ],
    })
    B.setSlide(nid, {
      objects: [
        { id: 'o1', type: 'shape', x: 0.1, y: 0, w: 0.2, h: 0.2, z: 1 },
        { id: 'o2', type: 'shape', x: 0.2, y: 0.7, w: 0.2, h: 0.2, z: 2 },
      ],
    })

    // RECONNECT: exchange snapshots (order-independent union merge).
    const snapA = internals(A)._crdt.snapshot()
    const snapB = internals(B)._crdt.snapshot()
    internals(B)._handleFabricMessage(JSON.stringify({ type: 'tree_snapshot', session: 'deckR', nodes: snapA }))
    internals(A)._handleFabricMessage(JSON.stringify({ type: 'tree_snapshot', session: 'deckR', nodes: snapB }))

    for (const s of [A, B]) {
      const objs = Object.fromEntries(
        (s.orderedSlides().find((x) => x.nodeId === nid)!.data.objects ?? []).map((o) => [o.id!, o]),
      ) as Record<string, { x?: number, y?: number }>
      expect(objs.o1.x).toBe(0.9)   // A's offline move survived
      expect(objs.o2.y).toBe(0.7)   // B's offline move survived
    }
    expect(A.orderedSlides()).toEqual(B.orderedSlides())
  })
})

// ---------------------------------------------------------------------------
// BUG10 (DMTAP ordered-domain audit) — grid.js / tree.js decoded a remote
// OpID's Lamport counter with a bare `parseInt` and compared the results
// numerically. A malformed counter (non-numeric, negative, or missing)
// parses to NaN, and NaN is neither `<` nor `>=` anything in JS: `ai !== bi`
// is always true and `ai < bi` is always false whenever either side is NaN.
// GridCRDT.apply() only rejects a candidate op when `opIdLess(op.id,
// existing.opId)` is true, and TreeCRDT's MOVE case only applies a move when
// `!opIdLess(op.id, n.ordId)` is true — both treat "false" as "this op wins".
// So a single hostile peer on the (unsigned, per the code's own header
// comments) fabric room could send ONE op with a garbage id and have it
// silently overwrite any cell or reorder/reparent any slide, unconditionally,
// regardless of the real Lamport order. This is the same class of bug as
// FEEDS.md §4.3's ordered-domain invariant (an anti-rollback/LWW rule is a
// claim about a total order, and it is only as sound as the domain the
// counter is decoded into) and the fix kerf-pub shipped for its `seq`/`ts`
// decode: reject a malformed counter at the decode boundary rather than
// admitting it into the comparison and hoping NaN happens to fail safe.
// ---------------------------------------------------------------------------
describe('BUG10: a malformed remote OpID counter cannot win an LWW compare', () => {
  beforeEach(() => { try { localStorage.clear(); sessionStorage.clear() } catch { /* jsdom */ } })

  it('grid: a hostile grid_op with a non-numeric counter does not overwrite an existing cell', () => {
    const fab = new FakeFabric()
    const s = new GridSession({ sessionId: 'sheetH', replicaId: 'victim', fabricClient: asFabricClient(fab) })
    s.setCell(0, 0, 'legit')
    expect(s.cells()).toEqual([{ r: 0, c: 0, v: 'legit' }])

    fab.dispatchEvent(new CustomEvent('message', {
      detail: { data: JSON.stringify({
        type: 'grid_op', session: 'sheetH',
        op: { kind: 1, id: '00000000000000000000_notanumber_evil', key: { r: 0, c: 0 }, v: 'HACKED' },
      }) },
    }))
    expect(s.cells()).toEqual([{ r: 0, c: 0, v: 'legit' }]) // unchanged, not 'HACKED'
  })

  it('grid: a hostile grid_op with a negative counter does not overwrite an existing cell', () => {
    const fab = new FakeFabric()
    const s = new GridSession({ sessionId: 'sheetH2', replicaId: 'victim', fabricClient: asFabricClient(fab) })
    s.setCell(0, 0, 'legit')

    fab.dispatchEvent(new CustomEvent('message', {
      detail: { data: JSON.stringify({
        type: 'grid_op', session: 'sheetH2',
        op: { kind: 1, id: '00000000000000000000_-5_evil', key: { r: 0, c: 0 }, v: 'HACKED' },
      }) },
    }))
    expect(s.cells()).toEqual([{ r: 0, c: 0, v: 'legit' }])
  })

  it('grid: a well-formed higher-counter op still legitimately wins (fix does not break LWW)', () => {
    const fab = new FakeFabric()
    const s = new GridSession({ sessionId: 'sheetH3', replicaId: 'victim', fabricClient: asFabricClient(fab) })
    s.setCell(0, 0, 'legit') // victim's own counter is small (this replica's first tick)

    fab.dispatchEvent(new CustomEvent('message', {
      detail: { data: JSON.stringify({
        type: 'grid_op', session: 'sheetH3',
        op: { kind: 1, id: '00000000000000000000_0000000099_peer', key: { r: 0, c: 0 }, v: 'newer' },
      }) },
    }))
    expect(s.cells()).toEqual([{ r: 0, c: 0, v: 'newer' }]) // a real higher counter still wins
  })

  it('tree: a hostile MOVE with a non-numeric counter does not reorder a slide', () => {
    const fab = new FakeFabric()
    const s = new TreeSession({ sessionId: 'deckH', replicaId: 'victim', fabricClient: asFabricClient(fab) })
    const first = s.insertSlide('a', { t: 'one' })
    const second = s.insertSlide('z', { t: 'two' })
    expect(s.orderedSlides().map((x) => x.nodeId)).toEqual([first, second])

    // TREE_OP_MOVE = 2. Move `first` past `second` with a garbage counter.
    fab.dispatchEvent(new CustomEvent('message', {
      detail: { data: JSON.stringify({
        type: 'tree_op', session: 'deckH',
        op: { kind: 2, id: '00000000000000000000_garbage_evil', target: first, parent: '', ordKey: 'zz' },
      }) },
    }))
    expect(s.orderedSlides().map((x) => x.nodeId)).toEqual([first, second]) // order unchanged
  })

  it('tree: a well-formed higher-counter MOVE still legitimately reorders (fix does not break LWW)', () => {
    const fab = new FakeFabric()
    const s = new TreeSession({ sessionId: 'deckH2', replicaId: 'victim', fabricClient: asFabricClient(fab) })
    const first = s.insertSlide('a', { t: 'one' })
    const second = s.insertSlide('z', { t: 'two' })

    fab.dispatchEvent(new CustomEvent('message', {
      detail: { data: JSON.stringify({
        type: 'tree_op', session: 'deckH2',
        op: { kind: 2, id: '00000000000000000000_0000000099_peer', target: first, parent: '', ordKey: 'zz' },
      }) },
    }))
    expect(s.orderedSlides().map((x) => x.nodeId)).toEqual([second, first]) // real reorder applies
  })
})

// ---------------------------------------------------------------------------
// BUG 7 (deep/office2) — Slides tree cold-join created a PHANTOM DUPLICATE slide
// after any reorder.
//
// A node's ordId ADVANCES on every moveSlide (LWW), so after a reorder
// ordId !== id. The tree_snapshot handler rebuilt the node with
// apply(INSERT, id: n.ordId) — keying it in the CRDT map by the MOVE op's id, a
// DIFFERENT key than n.id. The subsequent SET_TEXT (target: n.id) then found no
// such node and created a SECOND empty stub. Result: the joiner rendered a
// phantom duplicate empty slide (two slides where the peer had one) and lost the
// real slide's node identity → non-convergence after any reorder + cold-join.
// Fix: rebuild at id=n.id, then replay the MOVE (id: n.ordId) to converge ordKey.
// ---------------------------------------------------------------------------
describe('BUG7: slides tree cold-join after a reorder does not duplicate slides', () => {
  beforeEach(() => { try { localStorage.clear(); sessionStorage.clear() } catch { /* jsdom */ } })

  it('a moved slide cold-joins as ONE slide with the peer node id', () => {
    const fabA = new FakeFabric()
    const A = new TreeSession({ sessionId: 'deckX', replicaId: 'A', fabricClient: asFabricClient(fabA) })
    const nid = A.insertSlide('m', { title: 'S1' })
    A.moveSlide(nid, 'p') // ordId now advances past nid
    const nodes = internals(A)._crdt.snapshot()
    expect(A.orderedSlides()).toHaveLength(1)

    const fabB = new FakeFabric()
    const B = new TreeSession({ sessionId: 'deckX', replicaId: 'B', fabricClient: asFabricClient(fabB) })
    fabB.dispatchEvent(new CustomEvent('message', {
      detail: { data: JSON.stringify({ type: 'tree_snapshot', session: 'deckX', nodes }) },
    }))

    const bs = B.orderedSlides()
    expect(bs).toHaveLength(1)                    // was 2 (a phantom empty stub)
    expect(bs[0].nodeId).toBe(nid)               // real node identity preserved
    expect(bs[0].data).toEqual({ title: 'S1' })
  })

  it('multi-slide reorder cold-joins to the same order and count', () => {
    const fabA = new FakeFabric()
    const A = new TreeSession({ sessionId: 'deckY', replicaId: 'A', fabricClient: asFabricClient(fabA) })
    const n1 = A.insertSlide('b', { t: 'one' })
    A.insertSlide('n', { t: 'two' })
    const n3 = A.insertSlide('t', { t: 'three' })
    A.moveSlide(n3, 'a') // three to the front
    const nodes = internals(A)._crdt.snapshot()

    const fabB = new FakeFabric()
    const B = new TreeSession({ sessionId: 'deckY', replicaId: 'B', fabricClient: asFabricClient(fabB) })
    fabB.dispatchEvent(new CustomEvent('message', {
      detail: { data: JSON.stringify({ type: 'tree_snapshot', session: 'deckY', nodes }) },
    }))

    expect(B.orderedSlides().map((s) => s.nodeId))
      .toEqual(A.orderedSlides().map((s) => s.nodeId))
    expect(B.orderedSlides().map((s) => s.data.t)).toEqual(['three', 'one', 'two'])
    // Joiner edit to the moved slide must still win (clock seeded past ordId).
    B.setSlide(n1, { t: 'EDITED' })
    expect(B.orderedSlides().find((s) => s.nodeId === n1)!.data).toEqual({ t: 'EDITED' })
  })
})
