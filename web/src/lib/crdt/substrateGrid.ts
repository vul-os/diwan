/**
 * src/lib/crdt/substrateGrid.js
 *
 * Sheets' grid CRDT, backed by the SHARED KOTVA Sync substrate engine
 * (`@vul-os/kotva-sync`, loaded by `./kotvaSync.js`) instead of the hand-rolled
 * LWW map in `./grid.js`.
 *
 * WHY
 * ---
 * `grid.js` is a perfectly good LWW-map CRDT — and it is also one of several
 * such engines across the Vulos suite, each with its own clock, its own total
 * order, and its own set of bugs to find. `substrate/SYNC.md` §4.4 specifies
 * exactly this data type (an LWW register keyed by `(target, field)`, resolved
 * by HLC), and `@vul-os/kotva-sync` is the *same compiled implementation* a Rust
 * server runs — upstream reports it byte-identical across its native and WASM
 * surfaces against its frozen conformance vectors. Running Sheets on it makes
 * the grid's merge semantics interoperable with every other product that adopts
 * the substrate.
 *
 * It does NOT retire `grid.js`. This class is a DROP-IN for `GridSession` —
 * same constructor options, same methods, same events — and which one the
 * editor builds is chosen by the `VITE_SUBSTRATE_SYNC` flag (see
 * `src/lib/flags.js`). Two engines, both live; this one is now the DEFAULT, and
 * `grid.js` is what a deployment gets by building with the flag off.
 *
 * `grid.js` is NO LONGER an automatic fallback when the WASM load fails. It is
 * used then only when nothing in the session can replicate (no fabric, no update
 * log); otherwise the editor stays local-only for that session. The two engines
 * do not share a total order, so silently swapping one for the other on a
 * REPLICATING session can diverge two peers permanently with no error shown to
 * either. See the call site in `src/apps/sheets/SheetsEditor.jsx`.
 *
 * AND THE SAME RULE APPLIES TO THE PEER'S ENGINE, not just this one's. A session
 * advertises which algebra it folds ops with, classifies every inbound frame by
 * shape, and stops replicating entirely once it can prove a peer is on the other
 * engine — because the two engines' op payloads are unrelated, so a mixed room
 * exchanged nothing at all while both editors reported "Live". See
 * `./gridEngine.js`.
 *
 * THE MAPPING (Diwan's grid → SYNC.md §4.4)
 * -----------------------------------------
 *   namespace  'sheet'
 *   target     `cell:<r>,<c>`   — one LWW object per cell
 *   field      'v'              — one register per cell
 *   value      {tstr: 'v'+text} for a set, {tstr:'x'} for a clear
 *
 * The one-character value tag exists because a cleared cell and a cell holding
 * the empty string are DIFFERENT states, and `ext-value` (§4.1) has no null to
 * tell them apart with.
 *
 * WHY `clear` IS NOT A DEATH CERTIFICATE. The substrate has a purpose-built
 * remove-wins delete (§4.5, `kind 4`), and it is the wrong tool here. A death
 * certificate DOMINATES: once a cell is deleted, no ordinary `lww-set` can
 * revive it, however much later it happens. Diwan's grid is plain LWW — clear a
 * cell, type into it again, and the value comes back. Modelling clear as a
 * death certificate would silently swallow the second edit. Using the LWW
 * register for both preserves the existing, user-visible behaviour exactly.
 *
 * WHAT CHANGES, HONESTLY
 * ----------------------
 * The TOTAL ORDER differs. `grid.js` compares `(lamport counter, replicaId)`
 * and ignores wall-clock time entirely; the substrate compares a full HLC
 * `(wall, counter, author)` per §3. Both are deterministic total orders and
 * both converge — but for a given pair of concurrent writes to one cell they
 * can pick different winners. This is why the switch is a flag and not a
 * migration: within one deployment every replica runs the same path.
 *
 * AUTHENTICATION. Ops go in through `ingest_ambient_authenticated` — the §5.6
 * path for ops whose authenticity was established out of band. Diwan's grid ops
 * are unsigned today (they ride an authenticated fabric room / the server's own
 * update log), so this is the honest mapping and NOT a downgrade. It is also a
 * real hole on a multi-author untrusted transport, which is why the substrate
 * names it the way it does. Wiring `op_signing_input` / `op_attach_signature`
 * to a per-device WebCrypto key would close it; that is a separate change and
 * is deliberately not smuggled in here.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { loadSync, type KotvaSyncNamespace } from './kotvaSync.js'
import { bytesToB64, b64ToBytes } from './ydoc.js'
import {
  GridEngineGuard, ENGINE_KOTVA_SYNC, HELLO_TYPE,
  classifyOp, classifySnapshot, mismatchLogLine,
  type EngineMismatch,
} from './gridEngine.js'
import type { FabricClient } from '../collab/webrtc/fabric.js'
import type { SyncEngine, HlcClock } from '@vul-os/kotva-sync'
import type { ChartDescriptor, PivotDescriptor, ColorScaleRule, GridCellSnapshot } from './grid.js'

const NS = 'sheet'
const FIELD = 'v'
const VAL_SET = 'v'
const VAL_CLEAR = 'x'

const SNAPSHOT_KEY = (id: string) => `crdt_sgrid_${id}`
const OP_LOG_KEY = (id: string) => `crdt_sgrid_ops_${id}`
const MAX_OPLOG = 500

/** The loaded substrate namespace, or null until `initSubstrateSync()` resolves. */
let sync: KotvaSyncNamespace | null = null

/**
 * Load the substrate engine. MUST be awaited before constructing a
 * `SubstrateGridSession` — the engine is WASM and loads asynchronously, while
 * every session method (and every editor render that reads `cells()`) is
 * synchronous. Resolving the load up-front is what keeps it that way; the
 * alternative, buffering local edits behind an in-flight load, would mean the
 * user can type into a grid that is not yet recording. Idempotent.
 */
export async function initSubstrateSync(): Promise<KotvaSyncNamespace> {
  if (!sync) sync = await loadSync()
  return sync
}

/** True once the engine is loaded and sessions may be constructed. */
export function substrateSyncReady(): boolean {
  return sync !== null
}

/**
 * A 32-byte HLC author key derived from Diwan's short replica id.
 *
 * §3 requires a fixed-width author, and it participates in the HLC total order
 * and in every op's identity. SHA-256 of the replica id gives a deterministic,
 * collision-resistant 32 bytes for ids of ANY length — zero-padding the raw
 * UTF-8 would have quietly aliased two replicas whose ids share a 32-byte
 * prefix into one author, which merges their clocks and loses writes.
 *
 * This is an ADDRESSING derivation, not a security one: the author bytes here
 * are not a public key, because this path does not sign (see the header note).
 */
export function authorFromReplicaId(replicaId: string): Uint8Array {
  return sha256(new TextEncoder().encode(String(replicaId)))
}

function cellTarget(r: number, c: number): string {
  return `cell:${r},${c}`
}

function parseCellTarget(target: unknown): { r: number; c: number } | null {
  if (typeof target !== 'string' || !target.startsWith('cell:')) return null
  const [rs, cs] = target.slice(5).split(',')
  const r = Number(rs)
  const c = Number(cs)
  if (!Number.isInteger(r) || !Number.isInteger(c)) return null
  return { r, c }
}

export type SubstrateWireOp = { dsync: 1; b: string }

/**
 * The wire form of a substrate op inside an existing Diwan frame.
 *
 * The CANONICAL OP BYTES are the durable artifact (the upstream README's rule:
 * the engine is a fold over them). Diwan's update-log frames and fabric
 * messages are JSON, which cannot carry a `Uint8Array`, so the bytes travel
 * base64-wrapped. Nothing else is added — the envelope is transport, the bytes
 * are the semantics.
 */
function wireOp(bytes: Uint8Array): SubstrateWireOp {
  return { dsync: 1, b: bytesToB64(bytes) }
}

function opBytesFromWire(op: unknown): Uint8Array | null {
  if (!op || typeof op !== 'object') return null
  const o = op as Record<string, unknown>
  if (o.dsync !== 1 || typeof o.b !== 'string') return null
  const bytes = b64ToBytes(o.b)
  return bytes && bytes.length ? bytes : null
}

type DecodedHlc = unknown

type DecodedLwwOp = {
  kind: number
  ns: string
  target: string
  field: string
  value: { tstr?: string }
  hlc: DecodedHlc
}

export type SubstrateGridSessionOptions = {
  /** file / document id */
  sessionId: string
  /** stable per-tab id */
  replicaId: string
  /** live transport; null = local-only */
  fabricClient?: FabricClient | null
}

type FabricMessage = {
  type: string
  session: string
  op?: unknown
  opId?: string
  chart?: ChartDescriptor
  chartId?: string
  pivot?: PivotDescriptor
  pivotId?: string
  rule?: ColorScaleRule
  ruleId?: string
  action?: string
  engine?: string
  reply?: boolean
  cells?: unknown
}

export class SubstrateGridSession extends EventTarget {
  private _session: string
  private _replicaId: string
  private _fabric: FabricClient | null
  private _destroyed: boolean
  private _engine: SyncEngine
  private _clock: HlcClock
  private _winners: Map<string, { bytes: Uint8Array; hlc: string }>
  private _engineGuard: GridEngineGuard
  private _onFabricMessage?: (ev: Event) => void

  constructor({ sessionId, replicaId, fabricClient = null }: SubstrateGridSessionOptions) {
    super()
    if (!sync) {
      throw new Error(
        'SubstrateGridSession: await initSubstrateSync() before constructing a session',
      )
    }
    this._session = sessionId
    this._replicaId = replicaId
    this._fabric = fabricClient
    this._destroyed = false

    this._engine = new sync.SyncEngine()
    this._clock = new sync.HlcClock(authorFromReplicaId(replicaId))

    // The winning op per cell, so a snapshot frame can be COMPACTED.
    //
    // The engine deliberately exposes no "load this state" entry point — it is a
    // fold over ops, and `observable_state` is an output, not an input. So a
    // snapshot here is not the observable state; it is the minimal SET OF OPS
    // whose fold equals it, which for an LWW register is exactly one op per
    // cell. Ordering is decided by the engine's own `compare_hlc`, never by a
    // comparator re-implemented in this file.
    // key `${r},${c}` → { bytes: Uint8Array, hlc: string(JSON) }
    this._winners = new Map()

    // ENGINE-ADVERTISEMENT HANDSHAKE — see ./gridEngine.js for why refusing to
    // sync is the correct answer to a peer on `grid.js` rather than trying to
    // interoperate with it. In short: the two engines share wire TYPES but not
    // op PAYLOADS, so a mixed room exchanges nothing at all while both editors
    // report "Live". This latches the session closed the moment that is visible.
    this._engineGuard = new GridEngineGuard(ENGINE_KOTVA_SYNC, (info: EngineMismatch) => {
      console.error(mismatchLogLine(info))
      // Deferred one microtask — see the matching note in grid.js: a mismatch
      // can latch during this constructor, before the editor has subscribed.
      queueMicrotask(() => {
        this.dispatchEvent(new CustomEvent('engineMismatch', { detail: info }))
      })
    })

    this._loadLocal()

    if (this._fabric) {
      this._onFabricMessage = (ev: Event) => this._handleFabricMessage((ev as CustomEvent).detail.data)
      this._fabric.addEventListener('message', this._onFabricMessage)
      this._announceEngine()
    }
  }

  /** The engine mismatch that stopped this session, or null while it is sound. */
  get engineMismatch(): EngineMismatch | null {
    return this._engineGuard.mismatch
  }

  /**
   * Advertise which algebra this session folds ops with.
   *
   * Uses `_sendRaw`, not `_broadcast`: a hello carries no document state, and a
   * session that has already latched must still be able to answer — otherwise
   * the peer that caused the mismatch never learns of it and keeps typing into a
   * document it believes is shared.
   */
  private _announceEngine(reply = false): void {
    this._sendRaw({
      type: HELLO_TYPE, session: this._session, engine: ENGINE_KOTVA_SYNC, reply,
    })
  }

  // -------------------------------------------------------------------------
  // Local mutations
  // -------------------------------------------------------------------------

  /** Write a cell value and broadcast the op. */
  setCell(row: number, col: number, value: unknown): void {
    this._write(row, col, VAL_SET + String(value))
  }

  /** Clear a cell (LWW, not a death certificate — see the header). */
  clearCell(row: number, col: number): void {
    this._write(row, col, VAL_CLEAR)
  }

  private _write(row: number, col: number, tagged: string): void {
    const sy = sync as KotvaSyncNamespace
    const hlc = this._clock.tick(Date.now())
    const bytes = sy.encode_op(JSON.stringify({
      kind: 3, // lww-set (§4.2)
      ns: NS,
      target: cellTarget(row, col),
      field: FIELD,
      value: { tstr: tagged },
      hlc: JSON.parse(hlc),
    }))
    this._ingest(bytes)
    const op = wireOp(bytes)
    this._broadcast({ type: 'grid_op', session: this._session, op })
    this._persistOp(op)
    // Suppressed after an engine mismatch, for the same reason `_broadcast` is:
    // appending our canonical ops to an update log another engine is also
    // writing leaves a durable log that no single engine can fold.
    if (this._engineGuard.ok) {
      this.dispatchEvent(new CustomEvent('localOp', { detail: { op } }))
    }
  }

  // -------------------------------------------------------------------------
  // Durable update-log bridge — the SAME four-callback adapter contract
  // OpLogSync already uses for `grid.js`, so the persistence layer, the server
  // update log and the frame format are untouched by this adoption.
  // -------------------------------------------------------------------------

  /** Apply one op from the durable log. Idempotent (the engine dedups by op-id).
   *
   * The update log is the SECOND place two engines can meet — it is per-file and
   * durable, so a `grid.js` client appending to it leaves frames here that this
   * engine cannot fold. Same guard as the fabric path. */
  applyLogOp(op: unknown): boolean {
    if (this._engineGuard.observeShape(classifyOp(op))) return false
    return this._ingestWire(op)
  }

  /** Merge a snapshot frame: a compacted list of canonical ops (never a replace). */
  applyLogSnapshot(ops: unknown): void {
    if (this._engineGuard.observeShape(classifySnapshot(ops))) return
    if (!Array.isArray(ops)) return
    let changed = false
    for (const op of ops) if (this._ingestWire(op, { quiet: true })) changed = true
    this.saveLocal()
    if (changed) this.dispatchEvent(new CustomEvent('remoteOp', { detail: { snapshot: true } }))
  }

  /** The compacted op set to post as a durable snapshot frame. */
  logSnapshotData(): SubstrateWireOp[] {
    return [...this._winners.values()].map((w) => wireOp(w.bytes))
  }

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  /** Non-deleted cells as [{ r, c, v }] — the FortuneSheet celldata shape. */
  cells(): GridCellSnapshot[] {
    const state = JSON.parse(this._engine.observable_state_json())
    const out: GridCellSnapshot[] = []
    for (const [target, field, value] of state.lww || []) {
      if (field !== FIELD) continue
      const rc = parseCellTarget(target)
      if (!rc) continue
      const tagged = value && typeof value.tstr === 'string' ? value.tstr : null
      if (tagged === null || tagged[0] !== VAL_SET) continue // cleared or unknown tag
      out.push({ r: rc.r, c: rc.c, v: tagged.slice(1) })
    }
    out.sort((a, b) => (a.r !== b.r ? a.r - b.r : a.c - b.c))
    return out
  }

  /**
   * The engine's canonical state root (§6.1) — 33 content-addressed bytes over
   * the whole observable state.
   *
   * Two replicas that have converged produce the IDENTICAL root, so a test can
   * assert byte-identical convergence directly instead of comparing a rendered
   * projection and hoping the projection is faithful. `grid.js` has no
   * equivalent; this is a capability the shared engine adds.
   */
  stateRoot(): Uint8Array {
    return this._engine.state_root()
  }

  // -------------------------------------------------------------------------
  // Ingest
  // -------------------------------------------------------------------------

  /**
   * Apply canonical op bytes.
   *
   * `ingest_ambient_authenticated` still fully VALIDATES the op (§4.1 shape,
   * ext-value restriction, clock skew); only the signature check is skipped,
   * because these ops carry no signature. A malformed or hostile op throws a
   * coded substrate error, which is caught and dropped here rather than
   * corrupting the grid — the same fail-closed posture `grid.js` has toward an
   * op it cannot parse.
   */
  private _ingest(bytes: Uint8Array): boolean {
    const sy = sync as KotvaSyncNamespace
    let applied = false
    try {
      applied = this._engine.ingest_ambient_authenticated(bytes, Date.now())
    } catch {
      return false // coded substrate refusal — drop, never apply half an op
    }
    if (!applied) return false

    let decoded: DecodedLwwOp
    try {
      decoded = JSON.parse(sy.decode_op(bytes))
    } catch {
      return true
    }
    // Keep our clock ahead of anything we have seen (§3), or our next local
    // write would mint a lower HLC and LOSE to an op already in the document.
    try { this._clock.observe(JSON.stringify(decoded.hlc)) } catch { /* skew — ignore */ }
    this._recordWinner(decoded, bytes)
    return true
  }

  private _ingestWire(op: unknown, { quiet = false }: { quiet?: boolean } = {}): boolean {
    const bytes = opBytesFromWire(op)
    if (!bytes) return false
    const changed = this._ingest(bytes)
    if (changed && !quiet) {
      this._persistOp(op as SubstrateWireOp)
      this.dispatchEvent(new CustomEvent('remoteOp', { detail: { op } }))
    }
    return changed
  }

  /** Track the highest-HLC op per cell, using the ENGINE's comparator. */
  private _recordWinner(decoded: DecodedLwwOp, bytes: Uint8Array): void {
    const sy = sync as KotvaSyncNamespace
    const rc = parseCellTarget(decoded.target)
    if (!rc || decoded.field !== FIELD) return
    const key = `${rc.r},${rc.c}`
    const hlc = JSON.stringify(decoded.hlc)
    const prev = this._winners.get(key)
    if (prev) {
      let cmp = 0
      try { cmp = sy.compare_hlc(hlc, prev.hlc) } catch { cmp = 0 }
      if (cmp <= 0) return
    }
    this._winners.set(key, { bytes, hlc })
  }

  // -------------------------------------------------------------------------
  // Local persistence (localStorage) — same shape/keys discipline as grid.js
  // -------------------------------------------------------------------------

  saveLocal(): void {
    try {
      localStorage.setItem(SNAPSHOT_KEY(this._session), JSON.stringify(this.logSnapshotData()))
      localStorage.removeItem(OP_LOG_KEY(this._session))
    } catch { /* quota — ignore */ }
  }

  private _loadLocal(): void {
    try {
      const raw = localStorage.getItem(SNAPSHOT_KEY(this._session))
      if (raw) for (const op of JSON.parse(raw)) this._ingestWire(op, { quiet: true })
      const logRaw = localStorage.getItem(OP_LOG_KEY(this._session))
      if (logRaw) for (const op of JSON.parse(logRaw)) this._ingestWire(op, { quiet: true })
    } catch { /* corrupt storage — ignore */ }
  }

  private _persistOp(op: SubstrateWireOp): void {
    try {
      const logRaw = localStorage.getItem(OP_LOG_KEY(this._session))
      const ops: SubstrateWireOp[] = logRaw ? JSON.parse(logRaw) : []
      ops.push(op)
      if (ops.length > MAX_OPLOG) ops.splice(0, ops.length - MAX_OPLOG)
      localStorage.setItem(OP_LOG_KEY(this._session), JSON.stringify(ops))
    } catch { /* quota — ignore */ }
  }

  // -------------------------------------------------------------------------
  // Overlay objects (charts / pivots / colour scales)
  //
  // These are NOT grid CRDT state: the editor owns the arrays in the file
  // content and these methods only relay an intent over the live fabric, with
  // the receiver validating fail-closed. They are reproduced verbatim from
  // GridSession so this class is a true drop-in; the substrate is not involved,
  // and pretending otherwise would be a bigger change than the adoption itself.
  // -------------------------------------------------------------------------

  upsertChart(chart: ChartDescriptor): void {
    if (!chart || typeof chart.id !== 'string') return
    this._broadcast({ type: 'chart_op', session: this._session, opId: this._overlayId(), action: 'upsert', chart })
  }

  removeChart(chartId: string): void {
    if (typeof chartId !== 'string') return
    this._broadcast({ type: 'chart_op', session: this._session, opId: this._overlayId(), action: 'delete', chartId })
  }

  upsertPivot(pivot: PivotDescriptor): void {
    if (!pivot || typeof pivot.id !== 'string') return
    this._broadcast({ type: 'pivot_op', session: this._session, opId: this._overlayId(), action: 'upsert', pivot })
  }

  removePivot(pivotId: string): void {
    if (typeof pivotId !== 'string') return
    this._broadcast({ type: 'pivot_op', session: this._session, opId: this._overlayId(), action: 'delete', pivotId })
  }

  upsertColorScale(rule: ColorScaleRule): void {
    if (!rule || typeof rule.id !== 'string') return
    this._broadcast({ type: 'cs_op', session: this._session, opId: this._overlayId(), action: 'upsert', rule })
  }

  removeColorScale(ruleId: string): void {
    if (typeof ruleId !== 'string') return
    this._broadcast({ type: 'cs_op', session: this._session, opId: this._overlayId(), action: 'delete', ruleId })
  }

  /** An overlay op id: the HLC, encoded so the receiver can order LWW-by-id. */
  private _overlayId(): string {
    const h = JSON.parse(this._clock.tick(Date.now()))
    return `${h.wall}_${h.counter}_${this._replicaId}`
  }

  // -------------------------------------------------------------------------
  // Fabric transport (unchanged wire types — a substrate op is just a different
  // payload inside the SAME `grid_op` message the fabric already carries)
  // -------------------------------------------------------------------------

  /** Put a frame on the wire unconditionally. Only the handshake may use this. */
  private _sendRaw(msg: FabricMessage): void {
    if (!this._fabric) return
    try { this._fabric.send(JSON.stringify(msg)) } catch { /* disconnected */ }
  }

  private _broadcast(msg: FabricMessage): void {
    // Latched mismatch ⇒ emit no DOCUMENT frame. An op a mismatched peer cannot
    // fold is worse than no op: it keeps their editor looking live while their
    // document walks away from ours.
    if (!this._engineGuard.ok) return
    this._sendRaw(msg)
  }

  private _handleFabricMessage(raw: unknown): void {
    if (this._destroyed) return
    let msg: FabricMessage | undefined
    try { msg = (typeof raw === 'string' ? JSON.parse(raw) : raw) as FabricMessage } catch { return }
    if (!msg || msg.session !== this._session) return

    // The handshake is handled BEFORE the fail-closed gate, and is the only
    // thing that is — see the matching note in grid.js. A latched session that
    // went silent would leave the mismatched peer believing it is collaborating.
    if (msg.type === HELLO_TYPE) {
      this._engineGuard.observeAdvertisement(msg.engine)
      if (!msg.reply) this._announceEngine(true)
      return
    }

    if (!this._engineGuard.ok) return // fail closed on every subsequent frame

    if (msg.type === 'grid_op' && msg.op) {
      // Layer 2 of the handshake: a `grid.js` GridOp reaching here is proof of a
      // foreign engine even if that peer's bundle is too old to send a hello.
      // Before this check the op was dropped by `opBytesFromWire` returning
      // null — silently, with no event and nothing rendered.
      if (this._engineGuard.observeShape(classifyOp(msg.op))) return
      this._ingestWire(msg.op)
    } else if (msg.type === 'chart_op') {
      this.dispatchEvent(new CustomEvent('remoteOp', {
        detail: { chart: msg.chart, chartId: msg.chartId, action: msg.action, opId: msg.opId },
      }))
    } else if (msg.type === 'pivot_op') {
      this.dispatchEvent(new CustomEvent('remoteOp', {
        detail: { pivot: msg.pivot, pivotId: msg.pivotId, pivotAction: msg.action, opId: msg.opId },
      }))
    } else if (msg.type === 'cs_op') {
      this.dispatchEvent(new CustomEvent('remoteOp', {
        detail: { colorScale: msg.rule, colorScaleId: msg.ruleId, colorScaleAction: msg.action, opId: msg.opId },
      }))
    } else if (msg.type === 'grid_snapshot_request') {
      // Proof a new peer is present; re-advertise, since our constructor's hello
      // predates it.
      this._announceEngine(true)
      this._broadcast({ type: 'grid_snapshot', session: this._session, cells: this.logSnapshotData() })
    } else if (msg.type === 'grid_snapshot' && msg.cells) {
      this.applyLogSnapshot(msg.cells) // classifies the frame on the same guard
    }
  }

  requestSnapshot(): void {
    this._broadcast({ type: 'grid_snapshot_request', session: this._session })
  }

  destroy(): void {
    this._destroyed = true
    if (this._fabric && this._onFabricMessage) {
      this._fabric.removeEventListener('message', this._onFabricMessage)
    }
    this.saveLocal()
    try { this._engine.free() } catch { /* already freed */ }
  }
}
