/**
 * src/lib/crdt/tree.js
 *
 * Browser-side LWW ordered-tree CRDT for Slides (OFFICE-23).
 *
 * Mirrors backend/crdt/tree.go:
 *   - TreeOpInsert  — add a new slide node under root
 *   - TreeOpMove    — reorder / reparent (LWW on ordKey + parent)
 *   - TreeOpSetText — update slide content (LWW on value)
 *   - TreeOpDelete  — tombstone a slide
 *
 * Slide content is stored per node. Historically it was one JSON-encoded value
 * string mutated via a whole-slide LWW (TreeOpSetText). That clobbered
 * concurrent edits to DIFFERENT objects on the SAME slide (last-writer-wins on
 * the entire slide → one peer's move/edit lost). The node now carries an
 * OBJECT-GRANULAR slide state (per-object LWW + per-scalar LWW) so two peers
 * editing different objects converge to the union without loss:
 *   - TreeOpSetSlide — carries only the CHANGED objects (each with its own
 *     opId) and CHANGED scalar props (background/layout/…, each with its own
 *     opId); merge reconciles at object/scalar granularity, per-entry
 *     latest-wins. See TreeCRDT._slideState / applySetSlide below.
 * TreeOpSetText is still accepted for back-compat (old snapshots / old peers):
 * it folds in as a whole-slide LWW baseline that per-object ops then refine.
 *
 * Usage
 * -----
 *   import { TreeSession } from './crdt/tree.js';
 *
 *   const session = new TreeSession({ sessionId: fileId, replicaId, fabricClient });
 *   session.addEventListener('remoteOp', () => { ... rerender ... });
 *
 *   // Local ops:
 *   const nodeId = session.insertSlide(ordKey, slideData);
 *   session.setSlide(nodeId, slideData);
 *   session.moveSlide(nodeId, newOrdKey);
 *   session.deleteSlide(nodeId);
 *
 *   // Read ordered slides:
 *   const slides = session.orderedSlides(); // → [{ nodeId, data }]
 *
 *   session.destroy();
 */

import type { FabricClient } from '../collab/webrtc/fabric.js'

// ---------------------------------------------------------------------------
// Lamport clock (same as grid.js)
// ---------------------------------------------------------------------------

class LamportClock {
  replicaId: string
  c: number

  constructor(replicaId: string) {
    this.replicaId = replicaId
    this.c = 0
  }

  tick(): string {
    this.c += 1
    return this._format(this.c)
  }

  observe(remoteCounter: number): void {
    if (remoteCounter > this.c) this.c = remoteCounter
  }

  _format(counter: number): string {
    return (
      String(Date.now()).padStart(20, '0') +
      '_' +
      String(counter).padStart(10, '0') +
      '_' +
      this.replicaId
    )
  }
}

/**
 * Decode the counter segment of an OpID string ("wallMs_counter_replicaId")
 * as a non-negative integer, or return null if it isn't one.
 *
 * This is the ordered-domain decode boundary for the Lamport counter: an
 * anti-rollback / LWW rule is a claim about a total order, and it is only as
 * sound as the domain the counter is decoded into (the same invariant DMTAP's
 * SYNC.md §3 states for the HLC and FEEDS.md §4.3 states for `seq`). A bare
 * `parseInt` admits negatives and non-numeric garbage as NaN instead of
 * rejecting them here.
 */
function opIdCounter(id: unknown): number | null {
  const n = Number(String(id).split('_')[1])
  return Number.isInteger(n) && n >= 0 ? n : null
}

// Compare two OpID strings — returns true if a < b (mirrors OpID.Less).
//
// WAVE-56 SECURITY: `id` is a compound string carried verbatim over an
// unsigned P2P fabric room / durable snapshot — nothing enforces its shape
// before it reaches here. The previous implementation decoded the counter
// with a bare `parseInt` and compared the results with `<`/`!==`: a
// malformed counter (non-numeric, negative, or missing) parses to NaN, and
// NaN is neither `<` nor `>=` anything in JS, so `ai !== bi` is always true
// and `ai < bi` is always false whenever either side is malformed. The
// TREE_OP_MOVE handler below treats "opIdLess(op.id, n.ordId) returned
// false" as license to apply the move (`!opIdLess(...)`), so a single
// hostile peer sending one move with a garbage id could silently reparent
// or reorder any node, unconditionally, regardless of the real Lamport
// order. Reject at the decode boundary instead: a malformed id sorts
// strictly BELOW every well-formed one, in both argument positions, so it
// can never win a compare it takes part in.
function opIdLess(a: unknown, b: unknown): boolean {
  const ai = opIdCounter(a)
  const bi = opIdCounter(b)
  if (ai === null || bi === null) return ai === null && bi !== null
  if (ai !== bi) return ai < bi
  const ar = String(a).split('_')[2]
  const br = String(b).split('_')[2]
  return ar < br
}

// ---------------------------------------------------------------------------
// TreeOp kinds (matches backend/crdt/tree.go)
// ---------------------------------------------------------------------------

const TREE_OP_INSERT    = 1
const TREE_OP_MOVE      = 2
const TREE_OP_SET_TEXT  = 3
const TREE_OP_DELETE    = 4
// P1 — object-granular slide edit. Carries only the changed objects + scalars,
// each with its OWN opId, merged per-entry (latest-wins). This is what lets two
// peers editing DIFFERENT objects on one slide converge to the union.
const TREE_OP_SET_SLIDE = 5

// The implicit root has this nodeId.
const ROOT_ID = ''

// ---------------------------------------------------------------------------
// Op / slide shapes
// ---------------------------------------------------------------------------

/** An Excalidraw-like slide object — untrusted shape off the wire; only `id`
 *  and `z` (paint order) are relied on here. */
export type SlideObject = { id?: string, z?: number, [key: string]: unknown }
/** A slide: an object-array (`objects`) plus arbitrary scalar props
 *  (title/content/background/master/transition/animations/notes/…). */
export type Slide = { objects?: SlideObject[], [key: string]: unknown }

/** One changed object in a TREE_OP_SET_SLIDE — `obj: null` means deleted. */
export type SlideObjectOp = { id: string, opId: string, obj: SlideObject | null }
/** One changed scalar prop in a TREE_OP_SET_SLIDE. */
export type SlideScalarOp = { key: string, opId: string, val: unknown }

export type TreeOpInsert = { kind: typeof TREE_OP_INSERT, id: string, parent: string, ordKey: string }
export type TreeOpMove = { kind: typeof TREE_OP_MOVE, id: string, target: string, parent: string, ordKey: string }
export type TreeOpSetText = { kind: typeof TREE_OP_SET_TEXT, id: string, target: string, value?: string }
export type TreeOpDelete = { kind: typeof TREE_OP_DELETE, id: string, target: string }
export type TreeOpSetSlide = {
  kind: typeof TREE_OP_SET_SLIDE, id: string, target: string,
  objects?: SlideObjectOp[], scalars?: SlideScalarOp[],
}
export type TreeOp = TreeOpInsert | TreeOpMove | TreeOpSetText | TreeOpDelete | TreeOpSetSlide

// ---------------------------------------------------------------------------
// Slide value <-> object-granular state
// ---------------------------------------------------------------------------
//
// A slide is { objects: [...], ...scalars } (title, content, background,
// master, transition, animations, notes, …). The CRDT stores it as:
//   objects : Map<objectId, { opId, obj }>          // per-object LWW
//   objTomb : Map<objectId, opId>                    // per-object delete LWW
//   scalars : Map<scalarKey, { opId, val }>          // per-scalar LWW
// so concurrent edits to DIFFERENT objects/scalars both survive.

// Keys that live at the top level of a slide but are NOT the objects[] array.
// Everything except `objects` is a scalar prop with its own LWW stamp.
const OBJECTS_KEY = 'objects'

/** Deterministic JSON for equality checks (stable key order). */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  const rec = v as Record<string, unknown>
  const keys = Object.keys(rec).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(rec[k])).join(',') + '}'
}

function objectId(o: SlideObject | null | undefined, i: number): string {
  return o && typeof o === 'object' && typeof o.id === 'string' && o.id ? o.id : `_anon_${i}`
}

/** A per-node structured slide state's persisted form. */
export type SlideStateSnapshot = {
  objects: Array<{ id: string, opId: string, obj: SlideObject }>
  objTomb: Array<{ id: string, opId: string }>
  scalars: Array<{ key: string, opId: string, val: unknown }>
}

/**
 * A per-node structured slide state. Reconstructs to the plain slide object and
 * merges other states / ops per-object and per-scalar (latest opId wins).
 */
class SlideState {
  objects: Map<string, { opId: string, obj: SlideObject }>
  objTomb: Map<string, string>
  scalars: Map<string, { opId: string, val: unknown }>

  constructor() {
    this.objects = new Map()  // id → { opId, obj }
    this.objTomb = new Map()  // id → opId (delete stamp)
    this.scalars = new Map()  // key → { opId, val }
  }

  /** Apply a whole-slide LWW baseline (legacy SET_TEXT). Every field is stamped
   * with the SAME opId; per-object/per-scalar ops with a higher opId refine it. */
  applyWhole(opId: string, slide: Slide): void {
    if (!slide || typeof slide !== 'object') return
    for (const [key, val] of Object.entries(slide)) {
      if (key === OBJECTS_KEY) continue
      this._setScalar(key, opId, val)
    }
    if (Array.isArray(slide.objects)) {
      slide.objects.forEach((o, i) => this._setObject(objectId(o, i), opId, o))
    }
  }

  applySetSlide(op: TreeOpSetSlide): void {
    if (Array.isArray(op.objects)) {
      for (const e of op.objects) {
        if (!e || typeof e.id !== 'string') continue
        if (e.obj === null || e.obj === undefined) this._tombObject(e.id, e.opId)
        else this._setObject(e.id, e.opId, e.obj)
      }
    }
    if (Array.isArray(op.scalars)) {
      for (const e of op.scalars) {
        if (!e || typeof e.key !== 'string') continue
        this._setScalar(e.key, e.opId, e.val)
      }
    }
  }

  _setObject(id: string, opId: string, obj: SlideObject): void {
    const cur = this.objects.get(id)
    if (cur && !opIdLess(cur.opId, opId)) return   // keep newer
    this.objects.set(id, { opId, obj })
    // A set with a strictly-newer opId revives a tombstoned object.
    const t = this.objTomb.get(id)
    if (t && opIdLess(t, opId)) this.objTomb.delete(id)
  }

  _tombObject(id: string, opId: string): void {
    const cur = this.objTomb.get(id)
    if (cur && !opIdLess(cur, opId)) return
    this.objTomb.set(id, opId)
  }

  _setScalar(key: string, opId: string, val: unknown): void {
    const cur = this.scalars.get(key)
    if (cur && !opIdLess(cur.opId, opId)) return
    this.scalars.set(key, { opId, val })
  }

  /** True if there is any content (used to distinguish an empty node). */
  hasContent(): boolean {
    return this.scalars.size > 0 || this.objects.size > 0
  }

  /** Reconstruct the plain slide object. Objects that are tombstoned (with a
   * stamp >= their last set) are omitted. Objects[] is sorted by (z, id) so the
   * reconstruction is deterministic across replicas. */
  toSlide(): Slide {
    const slide: Slide = {}
    for (const [key, { val }] of this.scalars) slide[key] = val
    const live: SlideObject[] = []
    for (const [id, { obj }] of this.objects) {
      const t = this.objTomb.get(id)
      const setStamp = this.objects.get(id)!.opId
      if (t && !opIdLess(t, setStamp)) continue   // tombstone wins → dropped
      live.push(obj)
    }
    live.sort((a, b) => {
      const za = (a && typeof a.z === 'number') ? a.z : 0
      const zb = (b && typeof b.z === 'number') ? b.z : 0
      if (za !== zb) return za - zb
      const ia = objectId(a, 0), ib = objectId(b, 0)
      return ia < ib ? -1 : ia > ib ? 1 : 0
    })
    if (this.objects.size > 0) slide[OBJECTS_KEY] = live
    return slide
  }

  clone(): SlideState {
    const s = new SlideState()
    s.objects = new Map(this.objects)
    s.objTomb = new Map(this.objTomb)
    s.scalars = new Map(this.scalars)
    return s
  }

  snapshot(): SlideStateSnapshot {
    return {
      objects: [...this.objects.entries()].map(([id, { opId, obj }]) => ({ id, opId, obj })),
      objTomb: [...this.objTomb.entries()].map(([id, opId]) => ({ id, opId })),
      scalars: [...this.scalars.entries()].map(([key, { opId, val }]) => ({ key, opId, val })),
    }
  }

  static restore(snap: SlideStateSnapshot | null | undefined): SlideState {
    const s = new SlideState()
    if (!snap || typeof snap !== 'object') return s
    for (const e of snap.objects || []) if (e && typeof e.id === 'string') s.objects.set(e.id, { opId: e.opId, obj: e.obj })
    for (const e of snap.objTomb || []) if (e && typeof e.id === 'string') s.objTomb.set(e.id, e.opId)
    for (const e of snap.scalars || []) if (e && typeof e.key === 'string') s.scalars.set(e.key, { opId: e.opId, val: e.val })
    return s
  }

  /** Max opId carried anywhere in this state (to seed the Lamport clock). */
  maxOpId(): string {
    let mx = ''
    const consider = (id: string) => { if (id && (mx === '' || opIdLess(mx, id))) mx = id }
    for (const { opId } of this.objects.values()) consider(opId)
    for (const opId of this.objTomb.values()) consider(opId)
    for (const { opId } of this.scalars.values()) consider(opId)
    return mx
  }
}

/**
 * diffSlide — compare a prior reconstructed slide to the next slide and return
 * the set of CHANGED objects (added/edited/deleted) + CHANGED scalars, each to
 * be stamped with a fresh opId by the caller. Unchanged entries are omitted so
 * a local edit to ONE object only broadcasts that object — never clobbering a
 * concurrent peer edit to another object on the same slide.
 */
type SlideDiff = {
  objects: Array<{ id: string, obj: SlideObject | null }>
  scalars: Array<{ key: string, val: unknown }>
}

function diffSlide(prev: Slide | undefined, next: Slide | undefined): SlideDiff {
  const prevObjs = new Map((Array.isArray(prev?.objects) ? prev!.objects! : []).map((o, i) => [objectId(o, i), o] as const))
  const nextObjs = new Map((Array.isArray(next?.objects) ? next!.objects! : []).map((o, i) => [objectId(o, i), o] as const))

  const objects: Array<{ id: string, obj: SlideObject | null }> = []
  for (const [id, o] of nextObjs) {
    const before = prevObjs.get(id)
    if (!before || stableStringify(before) !== stableStringify(o)) objects.push({ id, obj: o })
  }
  for (const [id] of prevObjs) {
    if (!nextObjs.has(id)) objects.push({ id, obj: null })   // deleted
  }

  const scalars: Array<{ key: string, val: unknown }> = []
  const keys = new Set([...Object.keys(prev || {}), ...Object.keys(next || {})])
  keys.delete(OBJECTS_KEY)
  for (const key of keys) {
    const bv = prev ? prev[key] : undefined
    const nv = next ? next[key] : undefined
    if (stableStringify(bv) !== stableStringify(nv)) scalars.push({ key, val: nv })
  }
  return { objects, scalars }
}

// ---------------------------------------------------------------------------
// TreeCRDT — in-memory LWW ordered tree
// ---------------------------------------------------------------------------

type TreeNode = {
  id: string
  parent: string
  ordKey: string
  ordId: string
  slide: SlideState
  deleted: boolean
}

/** A node as read from a snapshot (own format — always fully populated) or a
 *  peer/legacy source (partial; missing fields fall back sanely). */
export type TreeNodeLike = {
  id: string
  parent?: string
  ordKey?: string
  ordId?: string
  deleted?: boolean
  slide?: SlideStateSnapshot
  value?: string
  valueId?: string
}

/** The full snapshot shape TreeCRDT.snapshot() always produces. */
export type TreeNodeSnapshot = {
  id: string
  parent: string
  ordKey: string
  ordId: string
  deleted: boolean
  slide: SlideStateSnapshot
  value: string
  valueId: string
}

class TreeCRDT {
  // nodeId (string) → { id, parent, ordKey, ordId, slide:SlideState, deleted }
  // (`slide` is the object-granular P1 state; the legacy value/valueId are
  // folded INTO it via applyWhole so old ops/snapshots still converge.)
  private _nodes: Map<string, TreeNode>

  constructor() {
    this._nodes = new Map()
  }

  private _newNode(over: Partial<TreeNode> = {}): TreeNode {
    return {
      id: '', parent: ROOT_ID, ordKey: '', ordId: '',
      slide: new SlideState(), deleted: false, ...over,
    }
  }

  apply(op: TreeOp): void {
    switch (op.kind) {
      case TREE_OP_INSERT: {
        if (this._nodes.has(op.id)) {
          // Node exists; fill parent/ordKey if we don't have a positioning op yet.
          const n = this._nodes.get(op.id)!
          if (!n.ordId || opIdLess(n.ordId, op.id)) {
            n.parent = op.parent
            n.ordKey = op.ordKey
            n.ordId  = op.id
          }
          return
        }
        this._nodes.set(op.id, this._newNode({
          id: op.id, parent: op.parent, ordKey: op.ordKey, ordId: op.id,
        }))
        break
      }
      case TREE_OP_MOVE: {
        const n = this._nodes.get(op.target)
        if (!n) {
          // Buffer node for late-arriving Insert.
          this._nodes.set(op.target, this._newNode({
            id: op.target, parent: op.parent, ordKey: op.ordKey, ordId: op.id,
          }))
          return
        }
        // LWW: keep current if its ordId >= op.id.
        if (n.ordId && !opIdLess(op.id, n.ordId) && op.id !== n.ordId) {
          if (this._wouldCycle(op.target, op.parent)) return
          n.parent = op.parent
          n.ordKey = op.ordKey
          n.ordId  = op.id
        } else if (!n.ordId) {
          if (this._wouldCycle(op.target, op.parent)) return
          n.parent = op.parent
          n.ordKey = op.ordKey
          n.ordId  = op.id
        }
        break
      }
      case TREE_OP_SET_TEXT: {
        // Legacy whole-slide LWW (old peers / old snapshots). Fold the whole
        // slide into the object-granular state stamped with op.id; per-object
        // and per-scalar SET_SLIDE ops with a higher opId then refine it.
        let n = this._nodes.get(op.target)
        if (!n) {
          n = this._newNode({ id: op.target })
          this._nodes.set(op.target, n)
        }
        let slide: Slide
        try { slide = op.value ? JSON.parse(op.value) : {} } catch { slide = {} }
        n.slide.applyWhole(op.id, slide)
        break
      }
      case TREE_OP_SET_SLIDE: {
        // P1 object-granular edit: merge changed objects/scalars per-entry LWW.
        let n = this._nodes.get(op.target)
        if (!n) {
          n = this._newNode({ id: op.target })
          this._nodes.set(op.target, n)
        }
        n.slide.applySetSlide(op)
        break
      }
      case TREE_OP_DELETE: {
        const n = this._nodes.get(op.target)
        if (!n) {
          this._nodes.set(op.target, this._newNode({ id: op.target, deleted: true }))
          return
        }
        n.deleted = true
        break
      }
    }
  }

  private _wouldCycle(node: string, newParent: string): boolean {
    let cur: string | undefined = newParent
    let limit = this._nodes.size + 1
    while (cur && cur !== ROOT_ID && limit-- > 0) {
      if (cur === node) return true
      const n = this._nodes.get(cur)
      if (!n) return false
      cur = n.parent
    }
    return limit <= 0
  }

  /** Return visible children of parent sorted by (ordKey, id). */
  children(parentId: string): string[] {
    const out: string[] = []
    for (const [id, n] of this._nodes) {
      if (!n.deleted && n.parent === parentId) out.push(id)
    }
    out.sort((a, b) => {
      const na = this._nodes.get(a)!
      const nb = this._nodes.get(b)!
      if (na.ordKey !== nb.ordKey) return na.ordKey < nb.ordKey ? -1 : 1
      return a < b ? -1 : a > b ? 1 : 0
    })
    return out
  }

  /** Depth-first ordered list of visible node ids from root. */
  order(): string[] {
    const out: string[] = []
    this._walk(ROOT_ID, out)
    return out
  }

  private _walk(parentId: string, out: string[]): void {
    for (const id of this.children(parentId)) {
      out.push(id)
      this._walk(id, out)
    }
  }

  /** Return the reconstructed plain slide object for a node (or undefined). */
  value(id: string): Slide | undefined {
    const n = this._nodes.get(id)
    if (!n || n.deleted) return undefined
    return n.slide.toSlide()
  }

  /** The raw SlideState for a node (used by TreeSession.setSlide diffing). */
  slideState(id: string): SlideState | null {
    const n = this._nodes.get(id)
    return n ? n.slide : null
  }

  /**
   * Merge a snapshot's per-object/per-scalar slide state into a node. This is a
   * UNION merge (per-entry LWW) — NOT a replace — so a cold-joining peer that
   * already holds its own concurrent object edits keeps them: the incoming state
   * only wins for entries whose opId is strictly newer. `n.slide` (from a new
   * peer's snapshot) is preferred; a legacy `value` is folded in via applyWhole.
   */
  mergeSlideSnapshot(id: string, snapNode: TreeNodeLike): void {
    let n = this._nodes.get(id)
    if (!n) { n = this._newNode({ id }); this._nodes.set(id, n) }
    if (snapNode.slide) {
      const incoming = SlideState.restore(snapNode.slide)
      for (const [oid, { opId, obj }] of incoming.objects) n.slide._setObject(oid, opId, obj)
      for (const [oid, opId] of incoming.objTomb) n.slide._tombObject(oid, opId)
      for (const [key, { opId, val }] of incoming.scalars) n.slide._setScalar(key, opId, val)
    } else if (snapNode.value !== undefined && snapNode.value !== '') {
      let slide: Slide
      try { slide = JSON.parse(snapNode.value) } catch { slide = {} }
      n.slide.applyWhole(snapNode.valueId || snapNode.ordId || snapNode.id, slide)
    }
  }

  snapshot(): TreeNodeSnapshot[] {
    const out: TreeNodeSnapshot[] = []
    for (const [, n] of this._nodes) {
      out.push({
        id: n.id, parent: n.parent, ordKey: n.ordKey, ordId: n.ordId,
        deleted: n.deleted,
        // Object-granular slide state (P1). `value`/`valueId` are kept for
        // BACK-COMPAT so an OLD peer reading this snapshot still gets a whole
        // slide; a new peer prefers `slide` and folds `value` in only if absent.
        slide: n.slide.snapshot(),
        value: JSON.stringify(n.slide.toSlide()),
        valueId: n.slide.maxOpId(),
      })
    }
    return out
  }

  restore(nodes: TreeNodeLike[]): void {
    this._nodes.clear()
    for (const n of nodes) {
      const node = this._newNode({
        id: n.id, parent: n.parent ?? ROOT_ID, ordKey: n.ordKey ?? '', ordId: n.ordId ?? '', deleted: !!n.deleted,
      })
      if (n.slide) {
        node.slide = SlideState.restore(n.slide)
      } else if (n.value !== undefined && n.value !== '') {
        // Legacy snapshot: fold the whole-slide value in under its valueId.
        let slide: Slide
        try { slide = JSON.parse(n.value) } catch { slide = {} }
        node.slide.applyWhole(n.valueId || n.ordId || n.id, slide)
      }
      this._nodes.set(n.id, node)
    }
  }
}

// ---------------------------------------------------------------------------
// Fractional-index helper (simple string-based)
// ---------------------------------------------------------------------------

/**
 * Return an ordKey string positioned between `before` and `after`.
 * Uses a simple midpoint-string approach; infinite precision.
 */
export function ordKeyBetween(before?: string | null, after?: string | null): string {
  const b = before || 'a'
  const a = after  || 'z'
  if (b < a) {
    // Return a string midway between the two.
    const mid = midString(b, a)
    if (mid && mid > b && mid < a) return mid
  }
  // Fallback: append 'm' to before.
  return b + 'm'
}

function midString(lo: string, hi: string): string {
  // Find first differing position.
  let i = 0
  while (i < lo.length && i < hi.length && lo[i] === hi[i]) i++
  if (i >= lo.length) {
    // lo is a prefix of hi — insert lo + mid char.
    const hc = hi.charCodeAt(i)
    const ac = 'a'.charCodeAt(0)
    if (hc > ac + 1) return lo + String.fromCharCode(Math.floor((ac + hc) / 2))
    return lo + 'a' + midChar(hi[i + 1])
  }
  const lc = lo.charCodeAt(i) || 'a'.charCodeAt(0)
  const hc = hi.charCodeAt(i)
  if (hc - lc > 1) return lo.slice(0, i) + String.fromCharCode(Math.floor((lc + hc) / 2))
  return lo + 'm'
}

function midChar(c: string | undefined): string {
  const code = c ? c.charCodeAt(0) : 'z'.charCodeAt(0)
  return String.fromCharCode(Math.floor(('a'.charCodeAt(0) + code) / 2))
}

// ---------------------------------------------------------------------------
// TreeSession — ties TreeCRDT to a FabricClient
// ---------------------------------------------------------------------------

const SNAPSHOT_KEY = (id: string) => `crdt_tree_${id}`
const OP_LOG_KEY   = (id: string) => `crdt_tree_ops_${id}`
const MAX_OPLOG    = 500

export type TreeSessionOptions = {
  sessionId: string
  replicaId: string
  fabricClient?: FabricClient | null
}

type FabricMessage = {
  type: string
  session: string
  op?: unknown
  nodes?: unknown
}

export class TreeSession extends EventTarget {
  private _session: string
  private _replicaId: string
  private _fabric: FabricClient | null
  private _clock: LamportClock
  private _crdt: TreeCRDT
  private _destroyed: boolean
  private _onFabricMessage?: (ev: Event) => void

  constructor({ sessionId, replicaId, fabricClient = null }: TreeSessionOptions) {
    super()
    this._session   = sessionId
    this._replicaId = replicaId
    this._fabric    = fabricClient
    this._clock     = new LamportClock(replicaId)
    this._crdt      = new TreeCRDT()
    this._destroyed = false

    this._loadLocal()

    if (this._fabric) {
      this._onFabricMessage = (ev: Event) => this._handleFabricMessage((ev as CustomEvent).detail.data)
      this._fabric.addEventListener('message', this._onFabricMessage)
    }
  }

  // -------------------------------------------------------------------------
  // Local mutations
  // -------------------------------------------------------------------------

  /**
   * Insert a new slide node.
   * @param ordKey - position key (use ordKeyBetween)
   * @param data   - slide data object (will be JSON-encoded as value)
   * @returns the new nodeId
   */
  insertSlide(ordKey: string, data?: Slide): string {
    const id = this._clock.tick()
    const op: TreeOpInsert = { kind: TREE_OP_INSERT, id, parent: ROOT_ID, ordKey }
    this._crdt.apply(op)
    this._broadcast({ type: 'tree_op', session: this._session, op })
    this._persistOp(op)
    this._emitLocalOp(op)

    // Set initial content — object-granular so it merges with concurrent edits.
    if (data !== undefined) this.setSlide(id, data)
    return id
  }

  /**
   * Update a slide's content. P1: instead of a whole-slide LWW, diff against the
   * CRDT's current reconstruction and broadcast ONLY the changed objects/scalars,
   * each stamped with its own opId. Two peers editing DIFFERENT objects on the
   * SAME slide therefore both survive (per-object LWW); two peers editing the
   * SAME object is deterministic per-object LWW.
   */
  setSlide(nodeId: string, data: Slide): void {
    const prev = this._crdt.value(nodeId) || {}
    const { objects, scalars } = diffSlide(prev, data || {})
    if (objects.length === 0 && scalars.length === 0) return   // nothing changed

    // Stamp every changed entry with its own fresh opId.
    const objOps: SlideObjectOp[] = objects.map((e) => ({ id: e.id, opId: this._clock.tick(), obj: e.obj }))
    const scalarOps: SlideScalarOp[] = scalars.map((e) => ({ key: e.key, opId: this._clock.tick(), val: e.val }))
    const op: TreeOpSetSlide = {
      kind: TREE_OP_SET_SLIDE, id: this._clock.tick(), target: nodeId,
      objects: objOps, scalars: scalarOps,
    }
    this._crdt.apply(op)
    this._broadcast({ type: 'tree_op', session: this._session, op })
    this._persistOp(op)
    this._emitLocalOp(op)
  }

  /** Move / reorder a slide. */
  moveSlide(nodeId: string, newOrdKey: string): void {
    const id = this._clock.tick()
    const op: TreeOpMove = { kind: TREE_OP_MOVE, id, target: nodeId, parent: ROOT_ID, ordKey: newOrdKey }
    this._crdt.apply(op)
    this._broadcast({ type: 'tree_op', session: this._session, op })
    this._persistOp(op)
    this._emitLocalOp(op)
  }

  /** Delete a slide. */
  deleteSlide(nodeId: string): void {
    const id = this._clock.tick()
    const op: TreeOpDelete = { kind: TREE_OP_DELETE, id, target: nodeId }
    this._crdt.apply(op)
    this._broadcast({ type: 'tree_op', session: this._session, op })
    this._persistOp(op)
    this._emitLocalOp(op)
  }

  // -------------------------------------------------------------------------
  // Durable update-log bridge (CRDT-native persistence) — the op-based analogue
  // of Docs' Yjs UpdateLogSync. A collab/OpLogSync mirrors the SAME tree ops
  // into the server's append-only per-file log so divergent offline slide edits
  // converge on reload with nothing discarded.
  // -------------------------------------------------------------------------

  /** Fire a 'localOp' event so an update-log sync can append the op as a frame. */
  private _emitLocalOp(op: TreeOp): void {
    this.dispatchEvent(new CustomEvent('localOp', { detail: { op } }))
  }

  /** Apply an op that arrived from the durable log (idempotent LWW). Same ingest
   * path as a fabric op, so clock-observe + re-render fire once. */
  applyLogOp(op: unknown): void {
    this._ingestTreeOp(op as TreeOp)
  }

  /** Merge a full snapshot from the durable log (per-object/per-scalar LWW union
   * — never a blind replace). */
  applyLogSnapshot(nodes: unknown): void {
    if (Array.isArray(nodes)) this._ingestSnapshotNodes(nodes as TreeNodeLike[])
  }

  /** The full compacted state to post as a durable snapshot frame. */
  logSnapshotData(): TreeNodeSnapshot[] {
    return this._crdt.snapshot()
  }

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  /**
   * Return ordered slides as [{ nodeId, data }].
   * data is the parsed slide object stored by insertSlide / setSlide.
   */
  orderedSlides(): Array<{ nodeId: string, data: Slide }> {
    return this._crdt.order().map((nodeId) => {
      const data = this._crdt.value(nodeId) || {}
      return { nodeId, data }
    })
  }

  // -------------------------------------------------------------------------
  // Persistence (localStorage)
  // -------------------------------------------------------------------------

  saveLocal(): void {
    try {
      localStorage.setItem(SNAPSHOT_KEY(this._session), JSON.stringify(this._crdt.snapshot()))
    } catch { /* quota — ignore */ }
  }

  private _loadLocal(): void {
    try {
      const raw = localStorage.getItem(SNAPSHOT_KEY(this._session))
      if (raw) {
        const nodes: TreeNodeSnapshot[] = JSON.parse(raw)
        this._crdt.restore(nodes)
        for (const n of nodes) {
          const seedIds: Array<string | undefined> = [n.ordId, n.valueId]
          if (n.slide) {
            for (const e of n.slide.objects || []) seedIds.push(e.opId)
            for (const e of n.slide.objTomb || []) seedIds.push(e.opId)
            for (const e of n.slide.scalars || []) seedIds.push(e.opId)
          }
          for (const opId of seedIds) {
            if (opId) {
              const parts = opId.split('_')
              this._clock.observe(parseInt(parts[1], 10) || 0)
            }
          }
        }
      }
      const logRaw = localStorage.getItem(OP_LOG_KEY(this._session))
      if (logRaw) {
        const ops: TreeOp[] = JSON.parse(logRaw)
        for (const op of ops) this._crdt.apply(op)
      }
    } catch { /* corrupt — ignore */ }
  }

  private _persistOp(op: TreeOp): void {
    try {
      const logRaw = localStorage.getItem(OP_LOG_KEY(this._session))
      const ops: TreeOp[] = logRaw ? JSON.parse(logRaw) : []
      ops.push(op)
      if (ops.length > MAX_OPLOG) ops.splice(0, ops.length - MAX_OPLOG)
      localStorage.setItem(OP_LOG_KEY(this._session), JSON.stringify(ops))
    } catch { /* quota — ignore */ }
  }

  // -------------------------------------------------------------------------
  // Fabric transport
  // -------------------------------------------------------------------------

  private _broadcast(msg: FabricMessage): void {
    if (!this._fabric) return
    try {
      this._fabric.send(JSON.stringify(msg))
    } catch { /* disconnected */ }
  }

  private _handleFabricMessage(raw: unknown): void {
    if (this._destroyed) return
    let msg: FabricMessage | undefined
    try { msg = (typeof raw === 'string' ? JSON.parse(raw) : raw) as FabricMessage } catch { return }
    if (!msg || msg.session !== this._session) return

    if (msg.type === 'tree_op' && msg.op) {
      this._ingestTreeOp(msg.op as TreeOp)
    } else if (msg.type === 'tree_snapshot_request') {
      this._broadcast({
        type: 'tree_snapshot',
        session: this._session,
        nodes: this._crdt.snapshot(),
      })
    } else if (msg.type === 'tree_snapshot' && msg.nodes) {
      this._ingestSnapshotNodes(msg.nodes as TreeNodeLike[])
    }
  }

  /** Ingest one tree op (fabric OR durable log): advance the Lamport clock,
   * apply, persist, and surface remoteOp for a re-render. */
  private _ingestTreeOp(op: TreeOp): void {
    if (!op) return
    const target = (op as { target?: string }).target
    for (const field of [op.id, target]) {
      if (field && typeof field === 'string') {
        const parts = field.split('_')
        this._clock.observe(parseInt(parts[1], 10) || 0)
      }
    }
    this._crdt.apply(op)
    this._persistOp(op)
    this.dispatchEvent(new CustomEvent('remoteOp', { detail: { op } }))
  }

  /** Merge a tree snapshot's nodes (cold-join / durable-log hydrate). */
  private _ingestSnapshotNodes(nodes: TreeNodeLike[]): void {
    for (const n of nodes) {
        // DATA-INTEGRITY: advance our Lamport clock past every counter carried in
        // the snapshot BEFORE the joiner edits anything. Otherwise the clock stays
        // low, our first setSlide/moveSlide mints a smaller OpID than the node
        // already holds, and the LWW guards (opIdLess on valueId/ordId) DROP the
        // joiner's edit — a slide text change or reorder silently reverts. The
        // tree_op path and _loadLocal already observe; this cold-join path must too.
        // Seed from ordId + every per-object/per-scalar opId in the granular slide
        // state (n.slide), plus the legacy valueId, so the joiner's first edit
        // mints a strictly-higher opId than anything the node already holds.
        const seedIds: Array<string | undefined> = [n.ordId, n.valueId]
        if (n.slide) {
          for (const e of n.slide.objects || []) seedIds.push(e.opId)
          for (const e of n.slide.objTomb || []) seedIds.push(e.opId)
          for (const e of n.slide.scalars || []) seedIds.push(e.opId)
        }
        for (const opId of seedIds) {
          if (opId && typeof opId === 'string') {
            const parts = opId.split('_')
            this._clock.observe(parseInt(parts[1], 10) || 0)
          }
        }
        // DATA-INTEGRITY: reconstruct the node under its OWN id (n.id), never
        // under n.ordId. A node's ordId ADVANCES on every moveSlide (LWW), so
        // after any reorder ordId !== id. The old code did apply(INSERT, id:
        // n.ordId): that keyed the node in the CRDT map by the MOVE op's id, a
        // DIFFERENT key than n.id. Then SET_TEXT (target: n.id) and DELETE found
        // no such node and created a second empty stub — the joiner rendered a
        // phantom duplicate slide and lost the real slide's identity (two slides
        // where the peer had one → non-convergence after any reorder + cold-join).
        // Establish the node at id=n.id first, then, if it was moved, replay the
        // MOVE (id: n.ordId) so the ordKey/ordId converge to the peer's LWW value.
        if (n.id) {
          this._crdt.apply({ kind: TREE_OP_INSERT, id: n.id, parent: n.parent ?? ROOT_ID, ordKey: n.ordKey ?? '' })
          if (n.ordId && n.ordId !== n.id) {
            this._crdt.apply({ kind: TREE_OP_MOVE, id: n.ordId, target: n.id, parent: n.parent ?? ROOT_ID, ordKey: n.ordKey ?? '' })
          }
          // P1: UNION-merge the object-granular slide state (per-object/per-scalar
          // LWW) instead of replaying a whole-slide SET_TEXT. A whole replay would
          // clobber a joiner's own concurrent edit to a DIFFERENT object; the merge
          // keeps both sides and only takes incoming entries that are strictly newer.
          this._crdt.mergeSlideSnapshot(n.id, n)
        }
        if (n.deleted) {
          this._crdt.apply({ kind: TREE_OP_DELETE, id: n.ordId || n.id, target: n.id })
        }
    }
    this.saveLocal()
    this.dispatchEvent(new CustomEvent('remoteOp', { detail: { snapshot: true } }))
  }

  /** Request a snapshot from peers on first join. */
  requestSnapshot(): void {
    this._broadcast({ type: 'tree_snapshot_request', session: this._session })
  }

  destroy(): void {
    this._destroyed = true
    if (this._fabric && this._onFabricMessage) {
      this._fabric.removeEventListener('message', this._onFabricMessage)
    }
    this.saveLocal()
  }
}

// ---------------------------------------------------------------------------
// Stable per-tab replicaId
// ---------------------------------------------------------------------------

export function getTreeReplicaId(): string {
  let id = sessionStorage.getItem('crdt_tree_replica')
  if (!id) {
    id = crypto.randomUUID().slice(0, 8)
    sessionStorage.setItem('crdt_tree_replica', id)
  }
  return id
}
