/**
 * src/lib/flags.js — build/deploy-time feature flags.
 *
 * ── VITE_DOCS_COLLAB — live co-editing in Docs ──────────────────────────────
 *
 * Docs' live collaboration (server relay + P2P invite links) is gated behind
 * this flag so a deployment can turn co-editing OFF and keep a perfectly good
 * single-user editor. It exists because collaborative sync is the one feature
 * whose failure mode is SILENT DATA CORRUPTION rather than a visible error:
 * a sync path that mis-maps a remote change onto the local document can move
 * content into the wrong node (inside a table cell, across a block boundary)
 * and the user has no way to know. When the flag is off, Docs never opens a
 * sync transport at all — no ops in, no ops out — and the UI says so plainly
 * instead of showing collaboration affordances that quietly do nothing.
 *
 * HONESTY CONTRACT (the reason this flag is not just an if-statement):
 *   • Off  → every co-editing affordance is hidden or explicitly labelled
 *            unavailable. A user must never believe their edits are syncing
 *            when they are not. See DocsEditor's "Live co-editing off" pill,
 *            the AccountShareModal notice, and the invite-link toast.
 *   • On   → co-editing runs the structure-aware (Yjs / y-prosemirror) path,
 *            which propagates formatting + structure and can never place a
 *            remote change at a wrong offset.
 *
 * Values: "on" | "1" | "true" enable; "off" | "0" | "false" disable.
 *
 * DEFAULT: ON. The sync path is now structure-aware (Yjs + y-prosemirror — see
 * lib/crdt/ydoc.js): remote changes arrive as ProseMirror transactions with
 * correctly mapped positions, so formatting and structure propagate and a remote
 * change can never be applied at a wrong offset. The flag remains as an operator
 * kill-switch — set VITE_DOCS_COLLAB=off to ship Docs as a single-user editor,
 * and the UI will say so plainly rather than degrade silently.
 *
 * (It defaulted OFF for exactly one commit: the transport before this one diffed
 * the document as PLAIN TEXT, which could not carry formatting at all and whose
 * character offsets did not address positions in a structured document — a remote
 * insert could land inside the wrong node and corrupt it.)
 */

function env(name) {
  try {
    // import.meta.env is replaced at build time by Vite; guard for non-Vite
    // consumers of the library build (jest/node) where it may be undefined.
    const e = typeof import.meta !== 'undefined' ? import.meta.env : undefined
    if (e && e[name] !== undefined) return String(e[name])
  } catch { /* no import.meta in this runtime */ }
  try {
    if (typeof process !== 'undefined' && process.env && process.env[name] !== undefined) {
      return String(process.env[name])
    }
  } catch { /* no process */ }
  return undefined
}

function boolFlag(name, dflt) {
  const raw = env(name)
  if (raw === undefined || raw === '') return dflt
  const v = raw.trim().toLowerCase()
  if (v === 'off' || v === '0' || v === 'false' || v === 'no') return false
  if (v === 'on' || v === '1' || v === 'true' || v === 'yes') return true
  return dflt
}

/**
 * True when Docs may open a live co-editing transport (server relay and/or the
 * P2P invite-link fabric). When false, Docs is a single-user editor: it still
 * autosaves, exports, comments, and version-histories exactly as before — it
 * simply never sends or applies a remote document op.
 */
export function docsCollabEnabled() {
  return boolFlag('VITE_DOCS_COLLAB', true)
}

/**
 * True when Docs should mirror local edits into the server's per-file CRDT
 * update log (CRDT-native persistence, phase 1) IN ADDITION to the existing
 * whole-document autosave (dual-write). Off by default: the whole-doc PUT
 * remains the sole durability path and no extra requests are made. Turn on with
 * VITE_UPDATE_LOG=on at build time, paired with the server flag
 * persistence.updatelog=true (the client also self-disables if the endpoint is
 * absent, so a mismatch degrades cleanly rather than erroring). See
 * src/lib/collab/updateLog.js and backend/updatelog.
 */
export function updateLogEnabled() {
  return boolFlag('VITE_UPDATE_LOG', false)
}

/**
 * True when Sheets should run its grid CRDT on the SHARED KOTVA Sync substrate
 * engine (`@vul-os/kotva-sync`, an LWW register per §4.4 of substrate/SYNC.md)
 * instead of the hand-rolled LWW map in src/lib/crdt/grid.js.
 *
 * Off by default, and additive exactly as VITE_UPDATE_LOG was: with the flag
 * off, not one byte of the substrate is loaded or executed and Sheets behaves
 * precisely as before. Turn on with VITE_SUBSTRATE_SYNC=on at build time.
 *
 * WHY A FLAG AND NOT A CUTOVER. The two engines are each internally convergent
 * but they do not share a TOTAL ORDER: grid.js resolves a conflicting write by
 * (lamport counter, replicaId) and ignores wall-clock time, while the substrate
 * resolves by a full HLC (wall, counter, author) per §3. For two concurrent
 * writes to the same cell they can therefore pick different winners. Every
 * replica in a deployment must run the SAME path, which a build-time flag
 * guarantees and a gradual rollout would not.
 *
 * The substrate engine is WASM and loads asynchronously, so the Sheets editor
 * awaits initSubstrateSync() before opening a session. If that load fails, the
 * editor falls back to the grid.js path rather than leaving the user with a
 * grid that silently records nothing.
 *
 * See src/lib/crdt/substrateGrid.js for the mapping and src/lib/crdt/kotvaSync.js
 * for how the published package is loaded.
 */
export function substrateSyncEnabled() {
  return boolFlag('VITE_SUBSTRATE_SYNC', false)
}

/** User-facing copy for why co-editing is unavailable (kept in one place). */
export const DOCS_COLLAB_OFF_NOTICE =
  'Live co-editing is turned off on this deployment. You can still share this ' +
  'document and take turns editing it, but changes will not appear in real time ' +
  "— reload to see someone else's saved edits, and avoid editing at the same time."
