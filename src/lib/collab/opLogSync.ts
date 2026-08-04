/**
 * src/lib/collab/opLogSync.js — the client side of CRDT-native persistence for
 * the OP-BASED CRDTs (Sheets' LWW grid, Slides' fractional tree). It is the
 * op-based sibling of updateLog.js's UpdateLogSync (which binds a Yjs Y.Doc): it
 * binds a hand-rolled op-CRDT session to the SAME server per-file append-only
 * update log (backend/updatelog: GET/POST /api/files/:id/updates).
 *
 * WHY A SECOND SYNC
 * -----------------
 * The update-log server is CRDT-AGNOSTIC — a frame is opaque bytes, and merge
 * semantics live entirely in the client. UpdateLogSync speaks Yjs (state
 * vectors / encodeStateAsUpdate). Sheets and Slides are op-based LWW CRDTs
 * (grid.js / tree.js): their durable unit is a discrete op, not a Yjs update.
 * This class carries those ops as frames — one debounced batch of local ops per
 * update frame, and the whole compacted state as a snapshot frame — and on load
 * replays snapshot-then-ops. Because the ops are commutative + idempotent under
 * LWW, applying them in any order (a peer's offline batch interleaved with ours)
 * converges to one state with nothing discarded — the exact guarantee Docs gets
 * from Yjs.
 *
 * FRAME WIRE FORM (opaque to the server)
 * --------------------------------------
 *   • update   frame data = utf8(JSON({ ops: [op, …] }))     — a batch of ops
 *   • snapshot frame data = utf8(JSON({ snapshot: <state> })) — the full state
 *
 * The session adapter (from the editor) supplies four callbacks so this class
 * never imports grid.js/tree.js and the CRDT layer never imports this:
 *   • subscribeLocal(cb) → unsub : cb(op) fires for each LOCAL op to append.
 *   • applyOp(op)                : apply one log op to the CRDT (idempotent).
 *   • applySnapshot(state)       : merge a full snapshot into the CRDT.
 *   • encodeSnapshot() → state   : the full compacted state for a snapshot frame.
 *
 * DUAL-WRITE (transition-safe): additive, exactly like UpdateLogSync. The
 * existing whole-document autosave keeps running; when the server flag
 * (persistence.updatelog) is off the endpoints 404 and this layer self-disables.
 */

import { bytesToB64, b64ToBytes } from '../crdt/ydoc.js'
import { apiTransport, type UpdateLogTransport, type UpdateLogTransportError, type UpdateLogLoadResult } from './updateLog.js'

const enc = new TextEncoder()
const dec = new TextDecoder()

function encodeFrame(payload: unknown): string {
  return bytesToB64(enc.encode(JSON.stringify(payload)))
}

function decodeFrame(data: string): unknown {
  try {
    const bytes = b64ToBytes(data)
    if (!bytes) return null
    return JSON.parse(dec.decode(bytes))
  } catch {
    return null
  }
}

export type OpLogSyncOptions = {
  /** required when no transport is supplied */
  fileId?: string
  /** inject a transport (tests) */
  transport?: UpdateLogTransport
  subscribeLocal?: (cb: (op: unknown) => void) => () => void
  applyOp: (op: unknown) => void
  applySnapshot?: (state: unknown) => void
  encodeSnapshot: () => unknown
  /** coalesce local ops before appending */
  debounceMs?: number
  /** append this many frames, then compact */
  snapshotEvery?: number
}

export class OpLogSync {
  private _t: UpdateLogTransport
  private _subscribeLocal: OpLogSyncOptions['subscribeLocal']
  private _applyOp: (op: unknown) => void
  private _applySnapshot: (state: unknown) => void
  private _encodeSnapshot: () => unknown
  private _debounceMs: number
  private _snapshotEvery: number
  private _enabled: boolean
  private _started: boolean
  private _flushing: boolean
  private _timer: ReturnType<typeof setTimeout> | null
  private _unsub: (() => void) | null
  private _buffer: unknown[]
  private _appendsSinceSnapshot: number
  coveredSeq: number

  constructor({
    fileId,
    transport,
    subscribeLocal,
    applyOp,
    applySnapshot,
    encodeSnapshot,
    debounceMs = 800,
    snapshotEvery = 200,
  }: OpLogSyncOptions) {
    if (typeof applyOp !== 'function' || typeof encodeSnapshot !== 'function') {
      throw new Error('OpLogSync: applyOp + encodeSnapshot are required')
    }
    this._t = transport || apiTransport(fileId)
    this._subscribeLocal = subscribeLocal
    this._applyOp = applyOp
    this._applySnapshot = applySnapshot || (() => {})
    this._encodeSnapshot = encodeSnapshot
    this._debounceMs = debounceMs
    this._snapshotEvery = snapshotEvery

    this._enabled = true
    this._started = false
    this._flushing = false
    this._timer = null
    this._unsub = null
    this._buffer = [] // local ops awaiting a flush
    this._appendsSinceSnapshot = 0
    this.coveredSeq = 0
  }

  get enabled(): boolean { return this._enabled }

  /** Fetch the snapshot + missing frames and apply them. Returns true if the
   * server has an update log (false → disabled, caller relies on whole-doc PUT). */
  async hydrate(): Promise<boolean> {
    let log: UpdateLogLoadResult
    try {
      log = await this._t.load(0)
    } catch {
      this._enabled = false
      return false
    }
    if (log.snapshot && log.snapshot.data) {
      const p = decodeFrame(log.snapshot.data) as { snapshot?: unknown } | null
      if (p && p.snapshot !== undefined) {
        try { this._applySnapshot(p.snapshot) } catch { /* keep going */ }
      }
    }
    for (const f of log.frames || []) {
      const p = decodeFrame(f.data) as { ops?: unknown[] } | null
      if (!p || !Array.isArray(p.ops)) continue
      for (const op of p.ops) {
        try { this._applyOp(op) } catch { /* one bad op must not wedge the load */ }
      }
    }
    this.coveredSeq = Number(log.head) || 0
    return true
  }

  /** Begin appending local ops. Safe to call once; no-op if disabled. */
  start(): void {
    if (this._started || !this._enabled || typeof this._subscribeLocal !== 'function') return
    this._started = true
    this._unsub = this._subscribeLocal((op) => {
      if (op === undefined || op === null) return
      this._buffer.push(op)
      this._schedule()
    })
  }

  /** Detach and flush any buffered ops. */
  async stop(): Promise<void> {
    if (!this._started) return
    this._started = false
    if (this._unsub) { try { this._unsub() } catch { /* already gone */ } this._unsub = null }
    if (this._timer) { clearTimeout(this._timer); this._timer = null }
    await this.flush()
  }

  private _schedule(): void {
    if (!this._enabled || this._timer) return
    this._timer = setTimeout(() => {
      this._timer = null
      this.flush().catch(() => { /* transport down — retry on the next op */ })
    }, this._debounceMs)
  }

  /** Append the buffered ops as one update frame (exactly the new ops). */
  async flush(): Promise<void> {
    if (!this._enabled || this._flushing || this._buffer.length === 0) return
    this._flushing = true
    // Take the batch; ops arriving during the append are captured by the next
    // flush (we only clear what we send, and re-queue on failure).
    const batch = this._buffer
    this._buffer = []
    try {
      const resp = await this._t.append({ kind: 'update', data: encodeFrame({ ops: batch }) })
      if (resp && typeof resp.seq === 'number') this.coveredSeq = resp.seq
      this._appendsSinceSnapshot++
      // Compact on our own budget OR the server's compaction nudge (resp.compact).
      if (this._appendsSinceSnapshot >= this._snapshotEvery || (resp && resp.compact)) {
        await this.snapshot()
      }
    } catch (err) {
      if ((err as UpdateLogTransportError)?.status === 404) {
        this._enabled = false // flag turned off — drop cleanly, whole-doc PUT covers durability
      } else {
        this._buffer = batch.concat(this._buffer) // retry these ops on the next flush
      }
    } finally {
      this._flushing = false
    }
  }

  /** Compact: post the whole state as a snapshot with floor = coveredSeq, so the
   * server can prune the frames it subsumes. */
  async snapshot(): Promise<void> {
    if (!this._enabled) return
    let state: unknown
    try { state = this._encodeSnapshot() } catch { return }
    try {
      const resp = await this._t.append({
        kind: 'snapshot',
        data: encodeFrame({ snapshot: state }),
        floor: this.coveredSeq,
      })
      if (resp && typeof resp.seq === 'number') this.coveredSeq = resp.seq
      this._appendsSinceSnapshot = 0
    } catch (err) {
      if ((err as UpdateLogTransportError)?.status === 404) this._enabled = false
      // A 409 (stale snapshot) is benign: another client already compacted.
    }
  }
}
