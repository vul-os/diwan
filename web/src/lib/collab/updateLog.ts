/**
 * src/lib/collab/updateLog.js — the client side of CRDT-native persistence
 * (phase 1). It binds a Y.Doc to the server's per-file append-only update log
 * (backend/updatelog: GET/POST /api/files/:id/updates).
 *
 * WHY (the durability model this replaces)
 * ----------------------------------------
 * The historical durability model is a single whole-document blob PUT guarded
 * by an optimistic-concurrency rev — two clients that both edited offline
 * collide on save and one has to discard + reconcile. Yjs updates are
 * commutative + idempotent, so if we simply KEEP every update frame instead of
 * overwriting a blob, divergent offline edits merge to one convergent document
 * with nothing dropped. This module is the client that appends those frames and
 * replays them on load.
 *
 * DUAL-WRITE (transition-safe): this is ADDITIVE. The existing whole-document
 * autosave keeps running; the update log is a second, convergent record. When
 * the server flag (persistence.updatelog) is off the endpoints 404 and this
 * layer disables itself, so a deployment can turn it on or off without ever
 * losing a document.
 *
 * FLOW
 * ----
 *   • hydrate(): fetch the snapshot + missing frames and apply them (as
 *     REMOTE_ORIGIN, so the local update handler does not echo them back out).
 *   • start(): on each LOCAL edit, debounce, then append the delta since the
 *     last flush (computed from a state vector — exactly the new content, never
 *     a whole-document resend).
 *   • compaction: after enough appends, post a `snapshot` frame (the whole
 *     compacted state) with floor = the highest seq it incorporates; the server
 *     prunes the frames the snapshot subsumes.
 *
 * The server is CONTENT-BLIND: frames are opaque bytes (here, base64 Yjs
 * updates). Nothing about merge semantics lives on the server.
 */

import * as Y from 'yjs'
import { REMOTE_ORIGIN, SEED_ORIGIN, bytesToB64, b64ToBytes } from '../crdt/ydoc.js'
import { api } from '../api.js'

export type UpdateLogFrame = { seq: number; kind: string; data: string; floor?: number }
export type UpdateLogAppendInput = { kind?: string; data: string; floor?: number }
export type UpdateLogAppendResult = { seq?: number; compact?: boolean; floor?: number }
export type UpdateLogLoadResult = {
  snapshot: UpdateLogFrame | null
  frames: UpdateLogFrame[]
  head: number
}
export type UpdateLogTransportError = Error & { status?: number }

/**
 * A transport is `{ load(since) -> {snapshot, frames, head}, append({kind,data,floor}) -> {seq} }`.
 * The default talks to the REST API; tests inject an in-memory one
 * (createMemoryUpdateLog) that mirrors the server's seq/snapshot semantics.
 */
export type UpdateLogTransport = {
  load(since?: number): Promise<UpdateLogLoadResult>
  append(frame: UpdateLogAppendInput): Promise<UpdateLogAppendResult>
}

export function apiTransport(fileId?: string): UpdateLogTransport {
  return {
    load: (since = 0) => api.getUpdates(fileId as string, since) as Promise<UpdateLogLoadResult>,
    append: (frame) => api.appendUpdate(fileId as string, frame) as Promise<UpdateLogAppendResult>,
  }
}

export class UpdateLogSync {
  private _ydoc: Y.Doc
  private _t: UpdateLogTransport
  private _debounceMs: number
  private _snapshotEvery: number
  private _enabled: boolean
  private _started: boolean
  private _dirty: boolean
  private _flushing: boolean
  private _timer: ReturnType<typeof setTimeout> | null
  private _appendsSinceSnapshot: number
  coveredSeq: number
  private _flushedSV: Uint8Array
  private _onLocalUpdate: (update: Uint8Array, origin: unknown) => void

  /**
   * @param opts.fileId      required when no transport is supplied
   * @param opts.transport   inject a transport (tests)
   * @param opts.debounceMs  coalesce local edits before appending
   * @param opts.snapshotEvery append this many frames, then compact
   */
  constructor({ ydoc, fileId, transport, debounceMs = 800, snapshotEvery = 150 }: {
    ydoc: Y.Doc
    fileId?: string
    transport?: UpdateLogTransport
    debounceMs?: number
    snapshotEvery?: number
  }) {
    if (!ydoc) throw new Error('UpdateLogSync: missing ydoc')
    this._ydoc = ydoc
    this._t = transport || apiTransport(fileId)
    this._debounceMs = debounceMs
    this._snapshotEvery = snapshotEvery

    this._enabled = true          // flips false if the server has no update log
    this._started = false
    this._dirty = false
    this._flushing = false
    this._timer = null
    this._appendsSinceSnapshot = 0
    this.coveredSeq = 0           // highest seq we have integrated
    // The state vector at the last flush: the next delta is everything the doc
    // has beyond this point.
    this._flushedSV = Y.encodeStateVector(ydoc)

    this._onLocalUpdate = (_update: Uint8Array, origin: unknown) => {
      // Skip our own applied frames (REMOTE_ORIGIN) and the deterministic
      // content seed (SEED_ORIGIN) — the seed is re-derived from the document's
      // authoritative content on every open, so logging it would just duplicate
      // content across peers. Only genuine local user edits are appended.
      if (origin === REMOTE_ORIGIN || origin === SEED_ORIGIN) return
      this._dirty = true
      this._schedule()
    }
  }

  get enabled() { return this._enabled }

  /** Fetch the snapshot + missing frames and apply them. Returns true if the
   * server has an update log (false → disabled, caller relies on whole-doc PUT). */
  async hydrate(): Promise<boolean> {
    let log: UpdateLogLoadResult
    try {
      log = await this._t.load(0)
    } catch {
      // 404 (flag off) or any transport failure: disable and fall back cleanly.
      this._enabled = false
      return false
    }
    try {
      if (log.snapshot && log.snapshot.data) {
        const bytes = b64ToBytes(log.snapshot.data)
        if (bytes) Y.applyUpdate(this._ydoc, bytes, REMOTE_ORIGIN)
      }
      for (const f of log.frames || []) {
        const bytes = b64ToBytes(f.data)
        if (bytes) Y.applyUpdate(this._ydoc, bytes, REMOTE_ORIGIN)
      }
    } catch {
      // A corrupt frame must never wedge the editor; stop applying, keep what
      // merged. Yjs applies are all-or-nothing per update, so the doc is intact.
    }
    this.coveredSeq = Number(log.head) || 0
    this._flushedSV = Y.encodeStateVector(this._ydoc)
    return true
  }

  /** Begin appending local edits. Safe to call once; no-op if disabled. */
  start(): void {
    if (this._started || !this._enabled) return
    this._started = true
    this._ydoc.on('update', this._onLocalUpdate)
  }

  /** Detach and flush any pending edit. */
  async stop(): Promise<void> {
    if (!this._started) return
    this._started = false
    try { this._ydoc.off('update', this._onLocalUpdate) } catch { /* already gone */ }
    if (this._timer) { clearTimeout(this._timer); this._timer = null }
    await this.flush()
  }

  private _schedule(): void {
    if (!this._enabled || this._timer) return
    this._timer = setTimeout(() => {
      this._timer = null
      this.flush().catch(() => { /* transport down — retry on the next edit */ })
    }, this._debounceMs)
  }

  /** Append the delta since the last flush (exactly the new content). */
  async flush(): Promise<void> {
    if (!this._enabled || this._flushing || !this._dirty) return
    this._flushing = true
    // Snapshot the dirty flag: edits arriving during the append are captured by
    // the NEXT flush (we clear only if the append succeeds).
    const sv = this._flushedSV
    const delta = Y.encodeStateAsUpdate(this._ydoc, sv)
    try {
      const resp = await this._t.append({ kind: 'update', data: bytesToB64(delta) })
      if (resp && typeof resp.seq === 'number') this.coveredSeq = resp.seq
      this._flushedSV = Y.encodeStateVector(this._ydoc)
      this._dirty = false
      this._appendsSinceSnapshot++
      // Compact when EITHER our own local budget is reached OR the server advises
      // it (resp.compact) — the server's compaction safety net fires when a log
      // has grown a large un-compacted tail that no single client is snapshotting
      // (it cannot fold opaque frames itself, so it nudges a client to do it).
      if (this._appendsSinceSnapshot >= this._snapshotEvery || (resp && resp.compact)) {
        await this.snapshot()
      }
    } catch (err) {
      // A 404 mid-life (flag turned off) disables the layer; otherwise keep the
      // dirty flag set so the edit is retried on the next flush.
      if ((err as UpdateLogTransportError)?.status === 404) this._enabled = false
    } finally {
      this._flushing = false
    }
  }

  /** Compact: post the whole state as a snapshot with floor = coveredSeq, so the
   * server can prune the frames it subsumes. */
  async snapshot(): Promise<void> {
    if (!this._enabled) return
    const state = Y.encodeStateAsUpdate(this._ydoc)
    try {
      const resp = await this._t.append({
        kind: 'snapshot',
        data: bytesToB64(state),
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

/**
 * createMemoryUpdateLog — an in-memory transport that mirrors the server's
 * append-only semantics (monotonic seq per file, snapshot floor + prune). It is
 * the executable contract the Go LocalStore implements, and the frontend
 * convergence tests drive it so they exercise the exact durability model
 * without a network.
 */
export function createMemoryUpdateLog(): UpdateLogTransport & { _debug: () => { head: number; frames: UpdateLogFrame[]; snapshot: UpdateLogFrame | null } } {
  let head = 0
  let frames: UpdateLogFrame[] = []
  let snapshot: UpdateLogFrame | null = null
  return {
    async load(since = 0) {
      const floor = snapshot ? (snapshot.floor ?? 0) : 0
      if (snapshot && since < floor) {
        return {
          snapshot,
          frames: frames.filter((f) => f.seq > floor),
          head,
        }
      }
      return { snapshot: null, frames: frames.filter((f) => f.seq > since), head }
    },
    async append({ kind = 'update', data, floor = 0 }: UpdateLogAppendInput) {
      head += 1
      const seq = head
      if (kind === 'snapshot') {
        const fl = Math.max(0, Math.min(floor, head - 1))
        if (snapshot && fl < (snapshot.floor ?? 0)) {
          const err: UpdateLogTransportError = new Error('stale snapshot')
          err.status = 409
          throw err
        }
        snapshot = { seq, kind, data, floor: fl }
        frames = frames.filter((f) => f.seq > fl)
        return { seq, floor: fl }
      }
      frames.push({ seq, kind, data })
      return { seq }
    },
    // Test introspection.
    _debug: () => ({ head, frames: [...frames], snapshot }),
  }
}
