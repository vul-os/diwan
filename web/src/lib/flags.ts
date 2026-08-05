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

function env(name: string): string | undefined {
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

function boolFlag(name: string, dflt: boolean): boolean {
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
 * True when Sheets should run its grid CRDT on the SHARED KOTVA Sync engine
 * (`@vul-os/kotva-sync`, an LWW register per §4.4 of the substrate's SYNC.md)
 * rather than the hand-rolled LWW map in src/lib/crdt/grid.js.
 *
 * DEFAULT: ON. Two Diwan replicas must converge because they run the SAME
 * compiled algebra — the one the substrate's frozen vectors pin — not because two
 * separate implementations happen to agree most of the time. Shipping the shared
 * engine behind an off-by-default flag meant the engine was PRESENT but was not
 * the path any real user took, which is the weaker of the two possible states and
 * the one that reads as compliance without being it.
 *
 * (It defaulted OFF while the adoption was being proved out: the mapping,
 * the convergence suite, and the package provenance pin all landed first. Those
 * are green — see src/lib/crdt/__tests__/substrateGrid.convergence.test.js and
 * substratePackageProvenance.test.js — so the default follows.)
 *
 * WHY IT IS STILL A BUILD-TIME FLAG rather than a runtime toggle. The two engines
 * are each internally convergent but they do not share a TOTAL ORDER: grid.js
 * resolves a conflicting write by (lamport counter, replicaId) and ignores
 * wall-clock time, while the substrate resolves by a full HLC (wall, counter,
 * author) per §3. For two concurrent writes to the same cell they can pick
 * different winners. Every replica in a deployment must therefore run the SAME
 * engine, which a build-time flag makes far likelier than a gradual rollout
 * would. Set VITE_SUBSTRATE_SYNC=off to ship the legacy engine deployment-wide.
 *
 * BUT THE FLAG IS NOT A GUARANTEE, so it is not the only defence. It fixes one
 * engine per BUILD, not one engine per ROOM: a tab loaded before the flag was
 * flipped is still open, the CommonJS library build below can never load the
 * .wasm and so always runs grid.js, and two deployments can meet through one
 * invite link. What a mixed room actually did was worse than picking different
 * winners — the two engines share the fabric's message types but not their op
 * payloads, so NOTHING crossed, in either direction, while both editors showed a
 * healthy roster. Sheets now advertises its engine and infers a peer's engine
 * from the shape of any op it sends, and REFUSES to keep replicating across a
 * mismatch. See src/lib/crdt/gridEngine.js.
 *
 * The engine is WASM and loads asynchronously, so the Sheets editor awaits
 * initSubstrateSync() before opening a session. IF THAT LOAD FAILS the editor
 * does NOT silently switch algebra: for a session that can replicate (a fabric is
 * attached, or the update log is on) it stays local-only for that session, because
 * falling back would risk permanent divergence from peers that loaded the engine
 * fine — invisible corruption in exchange for invisible convenience. Only when
 * nothing can replicate does it use grid.js. See the comment at the call site in
 * src/apps/sheets/SheetsEditor.jsx.
 *
 * KNOWN LIMITATION, stated rather than papered over: the CommonJS artifact of the
 * library build (vite.config.lib.js) replaces `import.meta` with `{}`, so it
 * cannot locate the `.wasm` and the load always fails there — a CJS consumer gets
 * a single-user grid. Use the ESM build for collaboration. See
 * src/lib/crdt/kotvaSync.js.
 *
 * See src/lib/crdt/substrateGrid.js for the mapping and src/lib/crdt/kotvaSync.js
 * for how the published package is loaded.
 */
export function substrateSyncEnabled() {
  return boolFlag('VITE_SUBSTRATE_SYNC', true)
}

/** User-facing copy for why co-editing is unavailable (kept in one place). */
export const DOCS_COLLAB_OFF_NOTICE =
  'Live co-editing is turned off on this deployment. You can still share this ' +
  'document and take turns editing it, but changes will not appear in real time ' +
  "— reload to see someone else's saved edits, and avoid editing at the same time."
