/**
 * src/lib/crdt/grid.js
 *
 * Browser-side LWW grid CRDT for Sheets (OFFICE-23).
 *
 * Mirrors backend/crdt/grid.go:
 *   - GridOpSet   — write a cell value (LWW: higher OpID wins)
 *   - GridOpClear — tombstone a cell
 *
 * OpID format (string-sortable, globally unique):
 *   "<20-digit wall-ms>_<10-digit counter>_<replicaId>"
 * Counter tiebreak: replica string comparison for total order (same as Go).
 *
 * Usage
 * -----
 *   import { GridSession } from './crdt/grid.js';
 *
 *   // fabricClient is a FabricClient instance (OFFICE-20); null → local-only.
 *   const session = new GridSession({ sessionId: fileId, replicaId, fabricClient });
 *   session.addEventListener('remoteOp', () => { ... rerender ... });
 *
 *   // Apply a cell edit locally and broadcast it:
 *   session.setCell(row, col, value);
 *   session.clearCell(row, col);
 *
 *   // Read the current grid state (for serialising to FortuneSheet celldata):
 *   const cells = session.snapshot(); // → [{ r, c, v }]
 *
 *   // When done:
 *   session.destroy();
 *
 * NOTE — this is no longer the only grid engine. `./substrateGrid.js` runs the
 * same grid on the shared KOTVA Sync engine and is the DEFAULT
 * (`VITE_SUBSTRATE_SYNC`); this file is what a deployment gets by building with
 * that flag off. The two speak the same fabric message TYPES with unrelated op
 * PAYLOADS, so a session here refuses to replicate once it detects a peer on the
 * other engine rather than silently exchanging nothing — see `./gridEngine.js`.
 */

import {
  GridEngineGuard, ENGINE_LOCAL_LWW, HELLO_TYPE,
  classifyOp, classifySnapshot, mismatchLogLine,
} from './gridEngine.js'

// ---------------------------------------------------------------------------
// Lamport clock (mirrors backend/crdt/id.go LamportClock)
// ---------------------------------------------------------------------------

class LamportClock {
  constructor(replicaId) {
    this.replicaId = replicaId
    this.c = 0
  }

  tick() {
    this.c += 1
    return this._format(this.c)
  }

  observe(remoteCounter) {
    if (remoteCounter > this.c) this.c = remoteCounter
  }

  _format(counter) {
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
function opIdCounter(id) {
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
// and `ai < bi` is always false whenever either side is malformed. Every
// caller in this file treats "opIdLess returned false" as license to apply
// the candidate op (`GridCRDT.apply` only rejects when `opIdLess(op.id,
// existing.opId)` is true) — so a single hostile peer sending one op with a
// garbage id could silently overwrite any cell, unconditionally, regardless
// of the real Lamport order. Reject at the decode boundary instead: a
// malformed id sorts strictly BELOW every well-formed one, in both argument
// positions, so it can never win a compare it takes part in.
function opIdLess(a, b) {
  const ai = opIdCounter(a)
  const bi = opIdCounter(b)
  if (ai === null || bi === null) return ai === null && bi !== null
  if (ai !== bi) return ai < bi
  const ar = String(a).split('_')[2]
  const br = String(b).split('_')[2]
  return ar < br
}

// ---------------------------------------------------------------------------
// GridOp kinds (matches backend/crdt/grid.go)
// ---------------------------------------------------------------------------

const GRID_OP_SET   = 1
const GRID_OP_CLEAR = 2

// ---------------------------------------------------------------------------
// GridCRDT — in-memory LWW map keyed by "r,c"
// ---------------------------------------------------------------------------

class GridCRDT {
  constructor() {
    // key: "r,c" → { opId, value, deleted }
    this._cells = new Map()
  }

  apply(op) {
    const key = `${op.key.r},${op.key.c}`
    const existing = this._cells.get(key)
    if (existing) {
      if (existing.opId === op.id || opIdLess(op.id, existing.opId)) return false
    }
    if (op.kind === GRID_OP_SET) {
      this._cells.set(key, { opId: op.id, value: op.v || '', deleted: false })
    } else if (op.kind === GRID_OP_CLEAR) {
      this._cells.set(key, { opId: op.id, value: '', deleted: true })
    }
    return true
  }

  get(r, c) {
    const cell = this._cells.get(`${r},${c}`)
    if (!cell || cell.deleted) return undefined
    return cell.value
  }

  /** Export non-deleted cells as { r, c, v } array (FortuneSheet celldata format). */
  cells() {
    const out = []
    for (const [key, cell] of this._cells) {
      if (cell.deleted) continue
      const [r, c] = key.split(',').map(Number)
      out.push({ r, c, v: cell.value })
    }
    out.sort((a, b) => a.r !== b.r ? a.r - b.r : a.c - b.c)
    return out
  }

  /** Restore from a snapshot array of { r, c, opId, value, deleted }. */
  restore(cells) {
    this._cells.clear()
    for (const cell of cells) {
      this._cells.set(`${cell.r},${cell.c}`, {
        opId: cell.opId, value: cell.value, deleted: cell.deleted,
      })
    }
  }

  /** Snapshot for persistence / cold-join. */
  snapshot() {
    const out = []
    for (const [key, cell] of this._cells) {
      const [r, c] = key.split(',').map(Number)
      out.push({ r, c, opId: cell.opId, value: cell.value, deleted: cell.deleted })
    }
    return out
  }
}

// ---------------------------------------------------------------------------
// GridSession — ties GridCRDT to a FabricClient (OFFICE-20 transport)
// ---------------------------------------------------------------------------

const SNAPSHOT_KEY = (id) => `crdt_grid_${id}`
const OP_LOG_KEY   = (id) => `crdt_grid_ops_${id}`
const MAX_OPLOG    = 500   // cap persisted log entries

export class GridSession extends EventTarget {
  /**
   * @param {object} opts
   * @param {string}        opts.sessionId     - file / document id
   * @param {string}        opts.replicaId     - stable per-tab id (use sessionStorage)
   * @param {FabricClient|null} [opts.fabricClient] - OFFICE-20 transport; null = local-only
   */
  constructor({ sessionId, replicaId, fabricClient = null }) {
    super()
    this._session   = sessionId
    this._replicaId = replicaId
    this._fabric    = fabricClient
    this._clock     = new LamportClock(replicaId)
    this._crdt      = new GridCRDT()
    this._destroyed = false

    // ENGINE-ADVERTISEMENT HANDSHAKE (see ./gridEngine.js). This session and a
    // substrateGrid.js session speak the same wire TYPES with unrelated op
    // PAYLOADS, so a mixed room is not a document that merges badly — it is one
    // where nothing crosses at all while both editors say "Live". The guard
    // latches closed on the first sign of a foreign engine and this session then
    // stops replicating entirely.
    this._engineGuard = new GridEngineGuard(ENGINE_LOCAL_LWW, (info) => {
      console.error(mismatchLogLine(info))
      // Deferred by one microtask because a mismatch can latch DURING this
      // constructor — a peer's reply to our opening hello arrives synchronously
      // on a same-process transport — and the editor cannot have subscribed yet.
      // The guard itself latches immediately; only the notification waits.
      queueMicrotask(() => {
        this.dispatchEvent(new CustomEvent('engineMismatch', { detail: info }))
      })
    })

    // Bootstrap from localStorage (cold-join persistence).
    this._loadLocal()

    // Wire fabric message handler.
    if (this._fabric) {
      this._onFabricMessage = (ev) => this._handleFabricMessage(ev.detail.data)
      this._fabric.addEventListener('message', this._onFabricMessage)
      this._announceEngine()
    }
  }

  /** The engine mismatch that stopped this session, or null while it is sound. */
  get engineMismatch() {
    return this._engineGuard.mismatch
  }

  /**
   * Advertise which algebra this session folds ops with.
   *
   * Sent with `_sendRaw`, NOT `_broadcast`: a hello carries no document state
   * and cannot corrupt anything, and a session that has already latched must
   * still be able to answer — otherwise the peer that caused the mismatch never
   * learns of it and keeps typing into a document it believes is shared. The
   * refusal has to be audible to be worth anything.
   */
  _announceEngine(reply = false) {
    this._sendRaw({
      type: HELLO_TYPE, session: this._session, engine: ENGINE_LOCAL_LWW, reply,
    })
  }

  // -------------------------------------------------------------------------
  // Local mutations — called by the editor
  // -------------------------------------------------------------------------

  /** Write a cell value and broadcast the op. */
  setCell(row, col, value) {
    const id = this._clock.tick()
    const op = { kind: GRID_OP_SET, id, key: { r: row, c: col }, v: String(value) }
    this._crdt.apply(op)
    this._broadcast({ type: 'grid_op', session: this._session, op })
    this._persistOp(op)
    this._emitLocalOp(op)
  }

  /** Tombstone a cell and broadcast the op. */
  clearCell(row, col) {
    const id = this._clock.tick()
    const op = { kind: GRID_OP_CLEAR, id, key: { r: row, c: col } }
    this._crdt.apply(op)
    this._broadcast({ type: 'grid_op', session: this._session, op })
    this._persistOp(op)
    this._emitLocalOp(op)
  }

  // -------------------------------------------------------------------------
  // Durable update-log bridge (CRDT-native persistence). These let a
  // collab/OpLogSync mirror the SAME cell ops into the server's append-only
  // per-file update log — the op-based analogue of Docs' Yjs UpdateLogSync. The
  // fabric transport is live/ephemeral; the update log is durable + convergent.
  // -------------------------------------------------------------------------

  /** Fire a 'localOp' event so an update-log sync can append the op as a frame.
   *  Suppressed after an engine mismatch: appending our frames to a log another
   *  engine is also writing leaves a durable log no single engine can fold. */
  _emitLocalOp(op) {
    if (!this._engineGuard.ok) return
    this.dispatchEvent(new CustomEvent('localOp', { detail: { op } }))
  }

  /** Apply an op that arrived from the durable log (idempotent LWW). Uses the
   * SAME ingest path as a fabric op, so clock-observe + re-render fire once.
   *
   * The update log is the SECOND way two engines can meet: it is per-file and
   * server-side, so a client on the other engine appending to it leaves frames
   * here that this engine cannot fold — the same unsound merge as a mixed
   * fabric room, just durable. Classified on the same guard. */
  applyLogOp(op) {
    if (this._engineGuard.observeShape(classifyOp(op))) return false
    return this._ingestGridOp(op)
  }

  /** Merge a full snapshot from the durable log (per-cell LWW union — never a
   * blind replace, so a concurrent local edit is not clobbered). */
  applyLogSnapshot(cells) {
    if (this._engineGuard.observeShape(classifySnapshot(cells))) return
    if (Array.isArray(cells)) this._ingestSnapshotCells(cells)
  }

  /** The full compacted state to post as a durable snapshot frame. */
  logSnapshotData() {
    return this._crdt.snapshot()
  }

  // -------------------------------------------------------------------------
  // Chart objects (WAVE-54) — plain-data descriptors, LWW-per-chart-id.
  //
  // Charts are structured overlay objects, not cells, so they ride a separate
  // op stream. A chart op carries a Lamport OpID for the same total order the
  // grid uses; a peer applies the higher OpID. The editor holds the authoritative
  // charts array in the file content; this stream just makes live-collab edits
  // (insert/move/edit/delete) propagate immediately over the fabric. Consumers
  // listen for the same 'remoteOp' event and merge `msg.chart`/`msg.chartId`.
  // -------------------------------------------------------------------------

  /** Broadcast an upsert of a chart descriptor (plain data). */
  upsertChart(chart) {
    if (!chart || typeof chart.id !== 'string') return
    const id = this._clock.tick()
    this._broadcast({ type: 'chart_op', session: this._session, opId: id, action: 'upsert', chart })
  }

  /** Broadcast a chart deletion by id. */
  removeChart(chartId) {
    if (typeof chartId !== 'string') return
    const id = this._clock.tick()
    this._broadcast({ type: 'chart_op', session: this._session, opId: id, action: 'delete', chartId })
  }

  // -------------------------------------------------------------------------
  // Pivot objects (WAVE-63) — plain-data descriptors, LWW-per-pivot-id.
  //
  // Same shape/discipline as chart ops: a pivot descriptor is structured
  // overlay data (not cells), so it rides a separate op stream carrying a
  // Lamport OpID for total order. The editor owns the pivots array in file
  // content; this stream just propagates live-collab edits immediately. The
  // ingress (SheetsEditor onRemote) MUST validate/clamp via makePivot — an
  // untrusted peer descriptor is never merged raw (WAVE-55 posture).
  // -------------------------------------------------------------------------

  /** Broadcast an upsert of a pivot descriptor (plain data). */
  upsertPivot(pivot) {
    if (!pivot || typeof pivot.id !== 'string') return
    const id = this._clock.tick()
    this._broadcast({ type: 'pivot_op', session: this._session, opId: id, action: 'upsert', pivot })
  }

  /** Broadcast a pivot deletion by id. */
  removePivot(pivotId) {
    if (typeof pivotId !== 'string') return
    const id = this._clock.tick()
    this._broadcast({ type: 'pivot_op', session: this._session, opId: id, action: 'delete', pivotId })
  }

  // -------------------------------------------------------------------------
  // Color-scale / data-bar CF rules (WAVE-63) — plain-data, LWW-per-rule-id.
  // Same discipline as chart/pivot ops. The editor ingress validates each
  // descriptor via makeColorScale (allow-listed kind, hex-validated colours) —
  // an untrusted peer rule is never merged raw.
  // -------------------------------------------------------------------------

  /** Broadcast an upsert of a colour-scale rule (plain data). */
  upsertColorScale(rule) {
    if (!rule || typeof rule.id !== 'string') return
    const id = this._clock.tick()
    this._broadcast({ type: 'cs_op', session: this._session, opId: id, action: 'upsert', rule })
  }

  /** Broadcast a colour-scale rule deletion by id. */
  removeColorScale(ruleId) {
    if (typeof ruleId !== 'string') return
    const id = this._clock.tick()
    this._broadcast({ type: 'cs_op', session: this._session, opId: id, action: 'delete', ruleId })
  }

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  /**
   * Return non-deleted cells as [{ r, c, v }].
   * Use to build FortuneSheet celldata on re-render.
   */
  cells() { return this._crdt.cells() }

  // -------------------------------------------------------------------------
  // Snapshot persistence (localStorage)
  // -------------------------------------------------------------------------

  saveLocal() {
    try {
      const snap = this._crdt.snapshot()
      localStorage.setItem(SNAPSHOT_KEY(this._session), JSON.stringify(snap))
    } catch { /* quota exceeded — ignore */ }
  }

  _loadLocal() {
    try {
      const raw = localStorage.getItem(SNAPSHOT_KEY(this._session))
      if (raw) {
        const cells = JSON.parse(raw)
        this._crdt.restore(cells)
        // Re-seed clock from max counter in the snapshot.
        for (const cell of cells) {
          if (cell.opId) {
            const parts = cell.opId.split('_')
            const counter = parseInt(parts[1], 10)
            if (!isNaN(counter)) this._clock.observe(counter)
          }
        }
      }
      // Replay persisted op-log for ops that arrived after last snapshot.
      const logRaw = localStorage.getItem(OP_LOG_KEY(this._session))
      if (logRaw) {
        const ops = JSON.parse(logRaw)
        for (const op of ops) this._crdt.apply(op)
      }
    } catch { /* corrupt storage — ignore */ }
  }

  _persistOp(op) {
    try {
      const logRaw = localStorage.getItem(OP_LOG_KEY(this._session))
      const ops = logRaw ? JSON.parse(logRaw) : []
      ops.push(op)
      // Cap log to avoid unbounded growth; a periodic saveLocal() resets it.
      if (ops.length > MAX_OPLOG) ops.splice(0, ops.length - MAX_OPLOG)
      localStorage.setItem(OP_LOG_KEY(this._session), JSON.stringify(ops))
    } catch { /* quota — ignore */ }
  }

  // -------------------------------------------------------------------------
  // Fabric transport
  // -------------------------------------------------------------------------

  /** Put a frame on the wire unconditionally. Only the handshake may use this. */
  _sendRaw(msg) {
    if (!this._fabric) return
    try {
      this._fabric.send(JSON.stringify(msg))
    } catch { /* disconnected — silently queue nothing; op is in localStorage */ }
  }

  _broadcast(msg) {
    // Once the engine guard has latched, this replica emits no DOCUMENT frame at
    // all. Sending an op a mismatched peer cannot fold is not harmless: it makes
    // that peer's editor look alive while its document walks away from ours.
    if (!this._engineGuard.ok) return
    this._sendRaw(msg)
  }

  _handleFabricMessage(raw) {
    if (this._destroyed) return
    let msg
    try { msg = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return }
    if (!msg || msg.session !== this._session) return

    // The handshake is handled BEFORE the fail-closed gate, and is the only
    // thing that is. A latched session must still answer a hello: silence would
    // leave the peer that caused the mismatch believing it is collaborating,
    // which is the precise failure this whole mechanism exists to end. A hello
    // carries no document state, so answering costs nothing.
    if (msg.type === HELLO_TYPE) {
      this._engineGuard.observeAdvertisement(msg.engine)
      // Answer an OPENING hello only (the reply flag terminates the exchange),
      // so a peer that joined after our constructor's announcement still learns
      // our engine without waiting for an op to be classified.
      if (!msg.reply) this._announceEngine(true)
      return
    }

    // Fail closed: a latched mismatch refuses every further frame, including
    // frames that would otherwise look perfectly well-formed.
    if (!this._engineGuard.ok) return

    if (msg.type === 'grid_op' && msg.op) {
      // Layer 2. A payload that is not the shape THIS engine emits is itself
      // proof of a foreign engine — and it is the layer that catches a peer on
      // a bundle old enough to send no hello at all, which is the commonest
      // mismatch there is.
      if (this._engineGuard.observeShape(classifyOp(msg.op))) return
      this._ingestGridOp(msg.op)
    } else if (msg.type === 'chart_op') {
      // Advance clock past the remote op id, then surface a chart event. The
      // editor owns the charts array; we just relay the intent to merge.
      if (msg.opId) {
        const parts = String(msg.opId).split('_')
        this._clock.observe(parseInt(parts[1], 10) || 0)
      }
      this.dispatchEvent(new CustomEvent('remoteOp', {
        detail: { chart: msg.chart, chartId: msg.chartId, action: msg.action, opId: msg.opId },
      }))
    } else if (msg.type === 'pivot_op') {
      // Advance clock past the remote op id, then surface a pivot event. The
      // editor owns the pivots array; we relay the intent to merge (validated
      // fail-closed at the ingress via makePivot).
      if (msg.opId) {
        const parts = String(msg.opId).split('_')
        this._clock.observe(parseInt(parts[1], 10) || 0)
      }
      this.dispatchEvent(new CustomEvent('remoteOp', {
        detail: { pivot: msg.pivot, pivotId: msg.pivotId, pivotAction: msg.action, opId: msg.opId },
      }))
    } else if (msg.type === 'cs_op') {
      if (msg.opId) {
        const parts = String(msg.opId).split('_')
        this._clock.observe(parseInt(parts[1], 10) || 0)
      }
      this.dispatchEvent(new CustomEvent('remoteOp', {
        detail: { colorScale: msg.rule, colorScaleId: msg.ruleId, colorScaleAction: msg.action, opId: msg.opId },
      }))
    } else if (msg.type === 'grid_snapshot_request') {
      // A cold-join request is also the moment a NEW peer is provably present,
      // so re-advertise: our constructor's hello predates this peer and it may
      // never have seen it.
      this._announceEngine(true)
      // Send our current snapshot to the requester.
      this._broadcast({
        type: 'grid_snapshot',
        session: this._session,
        cells: this._crdt.snapshot(),
      })
    } else if (msg.type === 'grid_snapshot' && msg.cells) {
      if (this._engineGuard.observeShape(classifySnapshot(msg.cells))) return
      // Cold-join: merge incoming snapshot cells.
      this._ingestSnapshotCells(msg.cells)
    }
  }

  /** Ingest one grid cell op (from the fabric OR the durable log): advance the
   * Lamport clock, apply (LWW), and on a real change persist + surface remoteOp.
   * Returns whether the op changed local state. */
  _ingestGridOp(op) {
    if (!op) return false
    // Advance clock past remote counter.
    if (op.id) {
      const parts = String(op.id).split('_')
      this._clock.observe(parseInt(parts[1], 10) || 0)
    }
    const changed = this._crdt.apply(op)
    if (changed) {
      this._persistOp(op)
      this.dispatchEvent(new CustomEvent('remoteOp', { detail: { op } }))
    }
    return changed
  }

  /** Merge a snapshot's cells (cold-join / durable-log hydrate). */
  _ingestSnapshotCells(cells) {
    for (const cell of cells) {
      if (cell.opId) {
        // DATA-INTEGRITY: advance our Lamport clock past every counter in the
        // snapshot BEFORE the joiner makes any edit. Otherwise the clock stays
        // low, our first setCell() mints a smaller OpID than the cell already
        // holds, and LWW (higher OpID wins) DROPS the joiner's edit — the user
        // types a value that silently reverts to the peer's. The grid_op path
        // and _loadLocal already observe; this cold-join path must too.
        const parts = String(cell.opId).split('_')
        this._clock.observe(parseInt(parts[1], 10) || 0)
        const kind = cell.deleted ? GRID_OP_CLEAR : GRID_OP_SET
        this._crdt.apply({ kind, id: cell.opId, key: { r: cell.r, c: cell.c }, v: cell.value })
      }
    }
    this.saveLocal()
    this.dispatchEvent(new CustomEvent('remoteOp', { detail: { snapshot: true } }))
  }

  /** Request the current snapshot from peers (call on first join). */
  requestSnapshot() {
    this._broadcast({ type: 'grid_snapshot_request', session: this._session })
  }

  destroy() {
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

export function getGridReplicaId() {
  let id = sessionStorage.getItem('crdt_grid_replica')
  if (!id) {
    id = crypto.randomUUID().slice(0, 8)
    sessionStorage.setItem('crdt_grid_replica', id)
  }
  return id
}
