/**
 * src/lib/crdt/gridEngine.js — the Sheets grid's ENGINE-ADVERTISEMENT HANDSHAKE.
 *
 * THE PROBLEM THIS EXISTS FOR
 * ---------------------------
 * Sheets has two grid engines that speak the SAME fabric wire types:
 *
 *   • `grid.js`          — the hand-rolled LWW map. Conflicts resolve by
 *                          (lamport counter, replicaId); wall-clock is ignored.
 *   • `substrateGrid.js` — the shared KOTVA Sync engine (§4.4 LWW register).
 *                          Conflicts resolve by a full HLC (wall, counter,
 *                          author).
 *
 * Both broadcast `{ type: 'grid_op', session, op }`. The `op` PAYLOADS are
 * unrelated: `{kind, id, key:{r,c}, v}` versus `{dsync:1, b:<canonical bytes>}`.
 * So when two peers in one document run different engines, what actually
 * happened before this module existed was NOT "they pick different winners
 * sometimes" — it was total, silent non-exchange:
 *
 *   substrate peer ← grid.js op   : `opBytesFromWire` returns null, op DROPPED,
 *                                   no error, no event, nothing rendered.
 *   grid.js peer   ← substrate op : `GridCRDT.apply` reads `op.key.r` on an
 *                                   undefined `key` and THROWS inside a fabric
 *                                   event listener — an uncaught console error
 *                                   per remote keystroke and no applied state.
 *   either ← the other's snapshot : dropped (substrate side) / skipped for a
 *                                   missing `opId` (grid.js side).
 *
 * Meanwhile the presence roster says "Live" and both users keep typing into
 * documents that will never converge. That is the exact failure mode the
 * substrate's own flowstock test names: a system that converges only by luck.
 *
 * THE DECISION: REFUSE, DO NOT DEGRADE
 * ------------------------------------
 * A CRDT's guarantee is conditional on every replica folding ops with the SAME
 * merge function. Two different merge functions in one document is not a
 * degraded mode — it is an unsound one, and it is unsound invisibly, which is
 * the worst property a data-integrity failure can have. So a session that
 * detects a peer on a different engine STOPS REPLICATING ALTOGETHER: it applies
 * no further remote frame and emits no further frame of its own, raises
 * `engineMismatch`, and the editor says so in plain words. The document stays
 * fully editable and the whole-document autosave is untouched — the user loses
 * live collaboration, visibly, instead of losing data, invisibly.
 *
 * This is deliberately the same posture as the WASM-load fallback rule in
 * `SheetsEditor.jsx`: never swap algebra underneath a session that can
 * replicate. That rule protects against a *local* engine change; this one
 * protects against a *remote* one, which no build-time flag can.
 *
 * WHY A BUILD-TIME FLAG IS NOT ALREADY ENOUGH
 * -------------------------------------------
 * `VITE_SUBSTRATE_SYNC` is baked into the bundle, so "every replica in a
 * deployment runs the same engine" holds for one build of one deployment. Each
 * of these breaks it, and each is ordinary:
 *
 *   1. DEPLOY SKEW. A tab loaded before the operator flipped the flag (or before
 *      a release that changed its default) is still open and still joining
 *      rooms. Same origin, two bundles.
 *   2. THE COMMONJS LIBRARY BUILD. `vite.config.lib.js`'s CJS artifact replaces
 *      `import.meta` with `{}`, so the `.wasm` can never be located there and
 *      that consumer always runs `grid.js` — while the first-party app on the
 *      same document runs the substrate. This is a documented limitation, not a
 *      hypothetical (see kotvaSync.js).
 *   3. TWO DEPLOYMENTS, ONE ROOM. Invite-link P2P meets at a room derived from
 *      the invite's key, and peer enrolment is manual over an operator-supplied
 *      address. Nothing requires both browsers to have loaded the same build.
 *
 * DETECTION IS TWO-LAYERED, ON PURPOSE
 * ------------------------------------
 *   1. ADVERTISEMENT — every session announces its engine id in a `grid_hello`
 *      frame and replies to a peer's hello with its own. Cheap, and it fires
 *      before a single op is exchanged.
 *   2. OP-SHAPE INFERENCE — a frame whose op payload is not the shape THIS
 *      engine emits is itself proof of a foreign engine, whether or not a hello
 *      ever arrived. This is the layer that matters: scenario 1 above is a peer
 *      running a bundle that predates `grid_hello` and will never send one. An
 *      advertisement-only handshake would have missed exactly the case it was
 *      built for.
 *
 * Both layers are fail-closed by construction: an op payload we cannot classify
 * is `UNKNOWN`, and UNKNOWN is treated as foreign. There is no shape that means
 * "probably fine".
 *
 * WHAT THIS MODULE IS NOT. It is not authentication. A hostile peer can claim
 * any engine id it likes — but a hostile peer that claims OUR engine and then
 * sends foreign ops is caught by layer 2, and one that sends well-formed ops of
 * our own engine is, by definition, not an engine-mismatch problem. Op
 * authenticity is a separate hole, named honestly in substrateGrid.js's header.
 *
 * THE COST OF FAILING CLOSED, STATED PLAINLY. Because an unclassifiable payload
 * counts as foreign, a peer already inside the fabric session can end everyone's
 * live collaboration by sending one frame of garbage. That is a real denial of
 * service and it is accepted deliberately, for two reasons. First, the peer that
 * can do it is a peer that is already admitted to the room, and Sheets' grid ops
 * are unsigned (see substrateGrid.js's AUTHENTICATION note) — so the same peer
 * could already overwrite every cell with whatever it liked, which is strictly
 * worse and much quieter. Second, the alternative is to treat "I do not
 * recognise this" as "carry on", which fails open on exactly the case this
 * module exists for: a payload shape we did not anticipate. Losing
 * collaboration loudly beats folding a foreign op silently. Signing ops would
 * close the DoS properly; the handshake is not the place to do it.
 */

// ── Engine identities ────────────────────────────────────────────────────────
//
// The id names the ALGEBRA and its total order, not the file, because that is
// what has to match for a fold to be sound. The trailing @N is the wire
// generation: bump it only if a change would make two peers of the same engine
// disagree, never for a refactor.

/** `grid.js` — hand-rolled LWW map, total order (lamport counter, replicaId). */
export const ENGINE_LOCAL_LWW = 'diwan/grid-lww-lamport@1'

/** `substrateGrid.js` — KOTVA Sync §4.4 LWW register, total order = HLC. */
export const ENGINE_KOTVA_SYNC = 'kotva-sync/lww-hlc@1'

/** Wire type carrying an engine advertisement. Unknown types are ignored by
 *  every existing handler, so a peer too old to understand this drops it. */
export const HELLO_TYPE = 'grid_hello'

// ── Op-shape classification ──────────────────────────────────────────────────

/** The payload is a `substrateGrid.js` canonical-op envelope. */
export const SHAPE_KOTVA_SYNC = 'kotva-sync'
/** The payload is a `grid.js` GridOp. */
export const SHAPE_LOCAL_LWW = 'local-lww'
/** Nothing recognisable. Treated as FOREIGN — never as benign. */
export const SHAPE_UNKNOWN = 'unknown'
/** Carries no engine signal at all (an empty snapshot). Never a mismatch. */
export const SHAPE_NONE = 'none'

const SHAPE_FOR_ENGINE = {
  [ENGINE_LOCAL_LWW]: SHAPE_LOCAL_LWW,
  [ENGINE_KOTVA_SYNC]: SHAPE_KOTVA_SYNC,
}

/**
 * Classify one op payload by its structure alone.
 *
 * Deliberately structural rather than tag-based: a peer that predates this
 * module stamps no engine tag on its ops, and that peer is the whole reason
 * layer 2 exists.
 *
 * @param {any} op
 * @returns {'kotva-sync'|'local-lww'|'unknown'|'none'}
 */
export function classifyOp(op) {
  if (op === null || op === undefined) return SHAPE_NONE
  if (typeof op !== 'object') return SHAPE_UNKNOWN
  if (op.dsync === 1 && typeof op.b === 'string') return SHAPE_KOTVA_SYNC
  if ((op.kind === 1 || op.kind === 2) && op.key && typeof op.key === 'object') {
    return SHAPE_LOCAL_LWW
  }
  return SHAPE_UNKNOWN
}

/**
 * Classify a snapshot frame's payload.
 *
 * `grid.js` posts cell records (`{r, c, opId, value, deleted}`);
 * `substrateGrid.js` posts a compacted list of canonical-op envelopes. An EMPTY
 * list is genuinely engine-neutral — a peer that has typed nothing yet must not
 * be accused of running a foreign engine — so it classifies as SHAPE_NONE.
 *
 * @param {any} cells
 * @returns {'kotva-sync'|'local-lww'|'unknown'|'none'}
 */
export function classifySnapshot(cells) {
  if (!Array.isArray(cells)) return SHAPE_UNKNOWN
  if (cells.length === 0) return SHAPE_NONE
  for (const entry of cells) {
    if (!entry || typeof entry !== 'object') return SHAPE_UNKNOWN
    if (entry.dsync === 1 && typeof entry.b === 'string') return SHAPE_KOTVA_SYNC
    if (typeof entry.opId === 'string' && Number.isInteger(entry.r) && Number.isInteger(entry.c)) {
      return SHAPE_LOCAL_LWW
    }
    return SHAPE_UNKNOWN
  }
  return SHAPE_NONE
}

/** The op shape a given engine emits. */
export function shapeForEngine(engineId) {
  return SHAPE_FOR_ENGINE[engineId] || SHAPE_UNKNOWN
}

// ── The guard ────────────────────────────────────────────────────────────────

/**
 * Tracks whether this session may still replicate, and latches CLOSED the first
 * time it sees evidence of a peer on another engine.
 *
 * The latch is one-way by design. A mismatched peer that leaves does not make
 * the document safe again: ops already crossed (or already failed to), and this
 * replica cannot know what the other one folded. Re-opening the document starts
 * a new session and a new handshake, which is the honest way back.
 */
export class GridEngineGuard {
  /**
   * @param {string} localEngine - one of the ENGINE_* ids
   * @param {(info: {local: string, remote: string, via: string}) => void} onMismatch
   *   Called EXACTLY once, the first time a mismatch is latched.
   */
  constructor(localEngine, onMismatch) {
    this.localEngine = localEngine
    this.localShape = shapeForEngine(localEngine)
    this._onMismatch = typeof onMismatch === 'function' ? onMismatch : () => {}
    /** @type {{local: string, remote: string, via: string}|null} */
    this.mismatch = null
  }

  /** True while this session is still allowed to send and apply ops. */
  get ok() {
    return this.mismatch === null
  }

  _latch(remote, via) {
    if (this.mismatch) return true
    this.mismatch = { local: this.localEngine, remote, via }
    this._onMismatch(this.mismatch)
    return true
  }

  /**
   * Layer 1: a peer advertised its engine.
   * @returns {boolean} true if this observation latched (or had already latched)
   *   the guard closed — i.e. the caller must not proceed.
   */
  observeAdvertisement(engineId) {
    if (this.mismatch) return true
    const id = typeof engineId === 'string' && engineId ? engineId : 'unadvertised'
    if (id === this.localEngine) return false
    return this._latch(id, 'advertisement')
  }

  /**
   * Layer 2: a frame arrived carrying an op/snapshot of some shape.
   * @param {string} shape - a SHAPE_* value from classifyOp/classifySnapshot
   * @returns {boolean} true if the frame must be REFUSED.
   */
  observeShape(shape) {
    if (this.mismatch) return true
    if (shape === SHAPE_NONE) return false
    if (shape === this.localShape) return false
    const remote =
      shape === SHAPE_KOTVA_SYNC ? ENGINE_KOTVA_SYNC
        : shape === SHAPE_LOCAL_LWW ? ENGINE_LOCAL_LWW
          : `unrecognised(${shape})`
    return this._latch(remote, 'op-shape')
  }
}

// ── User-facing copy (kept in one place, like DOCS_COLLAB_OFF_NOTICE) ────────

/**
 * What the Sheets editor tells the user. It says what stopped, what still
 * works, and what to do — and it never implies the other person's edits are on
 * their way, because they are not.
 */
export const GRID_ENGINE_MISMATCH_NOTICE =
  'Live co-editing stopped: someone in this spreadsheet is running a different ' +
  'sheet engine, so edits cannot be merged safely. Your work is still being ' +
  'saved. Reload once everyone is on the same version of this deployment.'

/** A one-line diagnostic for the console/log — engine ids are not user copy. */
export function mismatchLogLine({ local, remote, via }) {
  return (
    `[sheets] engine mismatch (detected via ${via}): this replica runs "${local}", ` +
    `a peer runs "${remote}". These do not share a merge function, so replication ` +
    'is stopped for this session rather than diverging silently.'
  )
}
