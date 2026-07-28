/**
 * src/lib/crdt/text.js
 *
 * Browser-side RGA text CRDT for Diwan (OFFICE-22).
 *
 * Mirrors backend/crdt/text.go and backend/crdt/id.go so that ops
 * encoded here are accepted by the Go Doc.ApplyRemote() and vice-versa.
 *
 * Wire format (JSON) matches the Go TextOp / OpID structs:
 *   { k: 1|2, id: {r,c}, p: {r,c}, v: <codepoint>, t: {r,c} }
 *   k=1 → Insert  k=2 → Delete
 *
 * Usage:
 *   const crdt = new TextCRDT('replica-a')
 *   const op = crdt.localInsert(0, 'H')   // insert 'H' at position 0
 *   crdt.apply(op)                         // apply locally
 *   // broadcast op to peers …
 *   crdt.apply(remoteOp)                   // merge remote op
 *   crdt.toString()                        // → current visible string
 */

// ---------------------------------------------------------------------------
// Lamport clock (matches Go LamportClock)
// ---------------------------------------------------------------------------

class LamportClock {
  constructor(replica) {
    this.replica = replica
    this.c = 0
  }

  tick() {
    this.c += 1
    return { r: this.replica, c: this.c }
  }

  observe(remoteC) {
    if (remoteC > this.c) this.c = remoteC
  }
}

// ---------------------------------------------------------------------------
// OpID helpers (match Go OpID.Less / Equal)
// ---------------------------------------------------------------------------

function opidLess(a, b) {
  if (a.c !== b.c) return a.c < b.c
  return a.r < b.r
}

function opidEqual(a, b) {
  return a.c === b.c && a.r === b.r
}

function opidZero(id) {
  return !id || (id.c === 0 && (!id.r || id.r === ''))
}

const ROOT_ID = { r: '', c: 0 }

// ---------------------------------------------------------------------------
// Op kind constants (match Go TextOpInsert / TextOpDelete)
// ---------------------------------------------------------------------------

export const TEXT_OP_INSERT = 1
export const TEXT_OP_DELETE = 2

// ---------------------------------------------------------------------------
// Ingress validation (WAVE-56 SECURITY — the recurring untrusted-CRDT class)
//
// Every remote transport (server SSE relay, E2E p2p, cloud fabric) and every
// bootstrap/snapshot path funnels a peer-supplied op/node THROUGH apply() /
// restore() here. A hostile peer (or a compromised relay, or a poisoned
// persisted op-log replayed to a late joiner) could previously send an op whose
// `v` was not a valid Unicode code point — String.fromCodePoint then throws
// RangeError INSIDE apply(), and on the server-SSE path (serverSession's
// es.onmessage) and the restore() path that throw is UNCAUGHT: it crashes the
// remote-op handler / editor, and because the op is persisted server-side it
// re-crashes every future joiner on bootstrap (persistent DoS). Same failure
// class as the Board laser (non-finite coords) and Sheets chart_op (peer
// descriptor merged without validation) fixes.
//
// Fix: validate/coerce at the ingress boundary and fail CLOSED — a malformed op
// is dropped (apply returns false), never applied, never throws. Valid code
// points are integers in [0, 0x10FFFF] excluding the UTF-16 surrogate range
// (0xD800–0xDFFF), which String.fromCodePoint also rejects.
// ---------------------------------------------------------------------------

const MAX_CODEPOINT = 0x10ffff

// Cap on buffered out-of-order deletes (targets not yet inserted). Bounds the
// memory a hostile/buggy peer can pin by streaming deletes for ids that will
// never exist. A legitimate reorder window is tiny; this is only a safety valve.
const MAX_PENDING_DELETES = 10000

/** True iff v is an integer that String.fromCodePoint accepts (no throw). */
function isValidCodePoint(v) {
  return (
    typeof v === 'number' &&
    Number.isInteger(v) &&
    v >= 0 &&
    v <= MAX_CODEPOINT &&
    !(v >= 0xd800 && v <= 0xdfff)
  )
}

/**
 * True iff `id` is a well-formed OpID { r: string, c: number }. The ROOT / a
 * missing parent is validated separately (opidZero handles p == null).
 */
function isValidOpId(id) {
  return (
    id != null &&
    typeof id === 'object' &&
    typeof id.c === 'number' &&
    Number.isFinite(id.c) &&
    (id.r === undefined || typeof id.r === 'string')
  )
}

// ---------------------------------------------------------------------------
// TextCRDT
// ---------------------------------------------------------------------------

export class TextCRDT {
  /**
   * @param {string} replicaId  - unique stable id for this peer
   */
  constructor(replicaId) {
    this._replica = replicaId
    this._clock = new LamportClock(replicaId)

    // Map<opid-key, node>  where node = { id, parent, value, deleted }
    this._nodes = new Map()
    // Map<opid-key, opid[]>  child lists kept sorted descending (RGA order)
    this._children = new Map()
    // Map<target-opid-key, true>  — deletes whose target INSERT has not yet been
    // seen (out-of-order / non-causal delivery). Held here and replayed the moment
    // the target node is inserted, so a delete can never be lost just because it
    // raced ahead of its insert on a different network path. Bounded to cap the
    // memory a hostile peer could pin by spamming deletes for never-existent ids.
    this._pendingDeletes = new Map()

    this._rootKey = _key(ROOT_ID)
    this._children.set(this._rootKey, [])
  }

  // ─── Local mutation helpers ─────────────────────────────────────────────

  /**
   * Produce an Insert op for character `ch` at visible index `i`
   * (0 = before all existing text).  Does NOT apply the op; caller
   * must call apply() after broadcasting.
   */
  localInsert(i, ch) {
    const id = this._clock.tick()
    const parent = this._parentAt(i)
    return { k: TEXT_OP_INSERT, id, p: parent, v: ch.codePointAt(0) }
  }

  /**
   * Produce a Delete op for the character at visible index `i`.
   * Returns null if the index is out of range.
   */
  localDelete(i) {
    const vis = this._visibleIds()
    if (i < 0 || i >= vis.length) return null
    const id = this._clock.tick()
    return { k: TEXT_OP_DELETE, id, t: vis[i] }
  }

  // ─── Apply (local + remote, idempotent) ─────────────────────────────────

  /**
   * Apply a TextOp produced locally or received from a peer.
   * Safe to call multiple times for the same op (idempotent).
   * Returns true if the op changed the document state.
   */
  apply(op) {
    // WAVE-56 SECURITY: op arrives from an untrusted peer/relay. Reject any
    // malformed shape fail-closed (return false) rather than let a bad field
    // throw inside apply and crash the remote-op handler / a late-joiner
    // bootstrap. Never trust `op` — validate before touching CRDT state.
    if (!op || typeof op !== 'object') return false

    if (op.k === TEXT_OP_INSERT) {
      // Insert MUST carry a well-formed OpID and a valid Unicode code point.
      // A non-finite/negative/out-of-range/non-number `v` would previously
      // throw RangeError in String.fromCodePoint (the recurring-class DoS).
      if (!isValidOpId(op.id)) return false
      if (!isValidCodePoint(op.v)) return false
      // Parent, when present, must be a well-formed OpID (or absent/zero → ROOT).
      if (op.p != null && !opidZero(op.p) && !isValidOpId(op.p)) return false

      const k = _key(op.id)
      if (this._nodes.has(k)) return false  // already seen

      this._clock.observe(op.id.c)
      const parent = op.p && !opidZero(op.p) ? op.p : ROOT_ID
      const parentKey = _key(parent)

      // A delete for this node may have arrived BEFORE this insert (out-of-order
      // delivery). If so it was buffered; honour it now so the char is born
      // already-deleted rather than lingering visible forever (a divergence bug).
      const bornDeleted = this._pendingDeletes.has(k)
      if (bornDeleted) this._pendingDeletes.delete(k)
      this._nodes.set(k, { id: op.id, parent, value: String.fromCodePoint(op.v), deleted: bornDeleted })
      if (!this._children.has(parentKey)) this._children.set(parentKey, [])
      this._insertChild(parentKey, op.id)
      // A char that is born already-deleted produced no visible change.
      return !bornDeleted
    }

    if (op.k === TEXT_OP_DELETE) {
      // Delete MUST carry a well-formed target OpID and its own OpID (for the
      // clock observe). Missing/malformed → drop rather than corrupt/throw.
      if (!isValidOpId(op.id)) return false
      if (!isValidOpId(op.t)) return false
      this._clock.observe(op.id.c)
      const targetKey = _key(op.t)
      const node = this._nodes.get(targetKey)
      if (!node) {
        // Target INSERT not seen yet (non-causal / reordered delivery). Buffer
        // the delete so it applies the instant the insert lands — dropping it
        // here would leave the char permanently visible on this replica while
        // the originating peer shows it deleted → the two never converge.
        if (this._pendingDeletes.size < MAX_PENDING_DELETES) {
          this._pendingDeletes.set(targetKey, true)
        }
        return false
      }
      if (node.deleted) return false
      node.deleted = true
      return true
    }

    return false
  }

  // ─── Read ───────────────────────────────────────────────────────────────

  /** Returns the visible text string. */
  toString() {
    const parts = []
    this._walk(this._rootKey, parts)
    return parts.join('')
  }

  /**
   * Returns an array of opids for currently-visible characters in order.
   * Used to resolve a cursor offset to a stable anchor before broadcasting.
   */
  visibleIds() {
    return this._visibleIds()
  }

  // ─── Snapshot / restore (for bucket persistence) ────────────────────────

  /**
   * Export a plain-object snapshot of the full CRDT state.
   * Equivalent to Go TextCRDT.snapshot().
   */
  snapshot() {
    const nodes = []
    for (const [, node] of this._nodes) {
      nodes.push({ id: node.id, p: node.parent, v: node.value.codePointAt(0), d: node.deleted })
    }
    // Stable deterministic order by OpID ascending (matches Go).
    nodes.sort((a, b) => opidLess(a.id, b.id) ? -1 : 1)
    return { nodes }
  }

  /**
   * MERGE a snapshot into the current state (union, non-destructive).
   *
   * Unlike restore() — which REPLACES local state — merge() folds every node of
   * an incoming snapshot into the existing CRDT via the same idempotent apply
   * path. This is the correct primitive for the snap/snap-req reconnection
   * exchange: when two peers edit OFFLINE and then reconnect, each holds nodes
   * the other lacks. A count-gated restore() ("replace only if the incoming
   * snapshot has MORE nodes") silently DROPS the smaller side's offline edits —
   * the peers "converge" only by one losing its work, and if the counts are
   * equal-but-different neither side ever learns the other's chars. Because RGA
   * apply is commutative + idempotent, merging both snapshots (in either order)
   * yields the union on both peers with zero loss.
   *
   * Returns true if the merge changed the visible document.
   */
  merge(snap) {
    if (!snap || !Array.isArray(snap.nodes)) return false
    let changed = false
    // Two passes so a delete whose target INSERT is later in the array is not
    // dropped to the pending buffer — apply all inserts first, then deletes.
    for (const n of snap.nodes) {
      if (!n || typeof n !== 'object' || !isValidOpId(n.id) || !isValidCodePoint(n.v)) continue
      const parent = n.p && !opidZero(n.p) ? n.p : ROOT_ID
      if (this.apply({ k: TEXT_OP_INSERT, id: n.id, p: parent, v: n.v })) changed = true
    }
    for (const n of snap.nodes) {
      if (!n || typeof n !== 'object' || !n.d || !isValidOpId(n.id)) continue
      if (this.apply({ k: TEXT_OP_DELETE, id: n.id, t: n.id })) changed = true
    }
    return changed
  }

  /**
   * Restore state from a snapshot (replaces current state).
   */
  restore(snap) {
    this._nodes.clear()
    this._children.clear()
    this._children.set(this._rootKey, [])
    this._pendingDeletes.clear()

    if (!snap || !Array.isArray(snap.nodes)) return

    // Sort ascending so parents are inserted before children.
    // WAVE-56 SECURITY: a snapshot arrives from an untrusted peer (p2p `snap`,
    // server `/collab/state` bootstrap, or a persisted-then-replayed op-log).
    // Skip any malformed node fail-closed — a bad `id`/`v` must not throw and
    // nuke the whole restore (which would crash every late joiner).
    const validNodes = [...snap.nodes].filter(
      (n) => n && typeof n === 'object' && isValidOpId(n.id) && isValidCodePoint(n.v),
    )
    const sorted = validNodes.sort((a, b) => opidLess(a.id, b.id) ? -1 : 1)
    let maxCounter = 0
    for (const n of sorted) {
      const k = _key(n.id)
      const parent = n.p && !opidZero(n.p) ? n.p : ROOT_ID
      const parentKey = _key(parent)
      this._nodes.set(k, { id: n.id, parent, value: String.fromCodePoint(n.v), deleted: !!n.d })
      if (!this._children.has(parentKey)) this._children.set(parentKey, [])
      this._insertChild(parentKey, n.id)
      if (n.id.c > maxCounter) maxCounter = n.id.c
    }
    // DATA-INTEGRITY: seed the Lamport clock past the highest counter we just
    // restored. Without this the clock stays at 0 after a reload/cold-start, so
    // the next localInsert mints an OpID with a tiny counter — which (a) can
    // COLLIDE with this replica's own restored ops (same replicaId + counter 1),
    // making apply() reject the new insert as "already seen" and SILENTLY DROP
    // the user's edit, and (b) sorts the new char before existing text in RGA
    // sibling order. Mirrors GridSession._loadLocal, which already re-seeds.
    this._clock.observe(maxCounter)
  }

  // ─── Internal helpers ───────────────────────────────────────────────────

  _parentAt(i) {
    if (i <= 0) return ROOT_ID
    const vis = this._visibleIds()
    if (vis.length === 0) return ROOT_ID
    if (i - 1 < vis.length) return vis[i - 1]
    return vis[vis.length - 1]
  }

  _visibleIds() {
    const out = []
    this._collectVisible(this._rootKey, out)
    return out
  }

  _collectVisible(parentKey, out) {
    const children = this._children.get(parentKey) || []
    for (const cid of children) {
      const k = _key(cid)
      const node = this._nodes.get(k)
      if (node && !node.deleted) out.push(cid)
      this._collectVisible(k, out)
    }
  }

  _walk(parentKey, parts) {
    const children = this._children.get(parentKey) || []
    for (const cid of children) {
      const k = _key(cid)
      const node = this._nodes.get(k)
      if (node && !node.deleted) parts.push(node.value)
      this._walk(k, parts)
    }
  }

  /**
   * Insert cid into parent's child list keeping it sorted in descending
   * OpID order (mirrors Go TextCRDT.insertChild).
   */
  _insertChild(parentKey, cid) {
    const children = this._children.get(parentKey)
    // Find insertion index: first position where children[i] < cid (descending).
    let idx = 0
    while (idx < children.length && !opidLess(children[idx], cid)) idx++
    children.splice(idx, 0, cid)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _key(id) {
  if (!id || opidZero(id)) return '__root__'
  return `${id.r}@${id.c}`
}
