/**
 * src/lib/crdt/boardYdoc.js — the Yjs document layer for WHITEBOARDS.
 *
 * The whiteboard is a new Office document type that rides the EXACT SAME
 * distributed, peer-to-peer collab engine as Docs (yP2PSession.js + FabricClient
 * over an E2E-encrypted room). This module is the whiteboard's counterpart to
 * ydoc.js: it owns the Yjs shape, the deterministic local seed, and — crucially —
 * the FAIL-CLOSED validator that every untrusted peer update passes through
 * before it can touch the live document.
 *
 * WHY A SEPARATE SHAPE (and why it still uses the docs transport)
 * --------------------------------------------------------------
 * A document is a Y.XmlFragment (ProseMirror). A whiteboard is a scene of
 * Excalidraw elements, stored one-per-id in a Y.Map (ELEMENTS_KEY) so concurrent
 * edits to DIFFERENT elements merge cleanly, plus a second Y.Map for image blobs
 * (FILES_KEY). This is board-ui's proven doc shape (src/doc.ts). The TRANSPORT is
 * unchanged: yP2PSession carries opaque Yjs updates inside sealed frames and asks
 * the context how to validate+apply them. Docs supplies a ProseMirror `schema`;
 * the whiteboard supplies THIS module's `applyUpdate` instead. Same encrypted
 * room, same content-blind relay, same TURN-only-on-hard-NAT fallback — no second
 * collab stack, and NO central whiteboard/collab server.
 *
 * SECURITY — every byte here is UNTRUSTED
 * ---------------------------------------
 * A peer inside the room may have been handed the key by anyone. An update can be
 * malformed (throwing inside Yjs decode — the fail-open class) or well-formed but
 * hostile (a billion elements to wedge the renderer, or an "image" blob that is
 * really active content — svg+xml/text-html — a stored-XSS vector on render). So:
 *   • applyRemoteBoardUpdate applies to a SHADOW doc first, validates the whole
 *     resulting scene, and only then touches the live doc. A rejected update is
 *     DROPPED and the shadow rebuilt, so one hostile frame cannot poison the next.
 *   • Image blobs must pass the SAME raster-only allow-list the binding enforces
 *     (isAllowedImage) — no svg+xml, no text/html masquerading as an image.
 */

import * as Y from 'yjs'
import { isAllowedImage } from '../../apps/whiteboard/binding.js'
import {
  REMOTE_ORIGIN,
  bytesToB64,
  b64ToBytes,
  encodeUpdateEnvelope,
} from './ydoc.js'

/** Y.Map<string, BoardElement> key holding the scene (one entry per element id). */
export const ELEMENTS_KEY = 'elements'
/** Y.Map<string, BoardFile> key holding image blobs (Excalidraw `files`). */
export const FILES_KEY = 'files'

/** An Excalidraw scene element — untrusted shape off the wire; only `id` and
 *  `index` (fractional ordering) are relied on here. */
export type BoardElement = { id: string; index?: string | number; [key: string]: unknown }
/** An Excalidraw file/image blob — untrusted shape off the wire. */
export type BoardFile = { mimeType?: string; dataURL?: string; [key: string]: unknown }
export type BoardScene = { elements: BoardElement[]; files: Record<string, BoardFile> }
export type BoardYContext = { ydoc: Y.Doc; shadow: Y.Doc; applyUpdate: typeof applyRemoteBoardUpdate }
export type ApplyBoardUpdateResult = { applied: boolean; reason?: string }

// ── Bounds (fail-closed) ────────────────────────────────────────────────────
// Generous ceilings for any real board; they exist so a hostile peer cannot ship
// a scene that wedges the renderer or blows the transport's per-frame cap.
const MAX_ELEMENTS = 100000
const MAX_FILES = 5000

/**
 * Validate a whiteboard scene held in a Y.Doc's element/file maps. Returns null
 * when clean, or a string reason when the document must be refused.
 *
 * A REJECT (not a strip): a legitimate peer never produces these, so the only
 * producer of a bad scene is a hostile one, and dropping its whole update is the
 * fail-closed answer — a partial strip would leave two peers divergent, which is
 * exactly the bug class this whole design avoids.
 */
export function validateBoardMaps(yElements: Y.Map<unknown>, yFiles: Y.Map<unknown>): string | null {
  if (yElements.size > MAX_ELEMENTS) return 'scene exceeds element ceiling'
  if (yFiles.size > MAX_FILES) return 'scene exceeds file ceiling'
  for (const el of yElements.values()) {
    if (!el || typeof el !== 'object') return 'malformed element'
    if (typeof (el as BoardElement).id !== 'string' || (el as BoardElement).id.length === 0) return 'element without id'
  }
  for (const f of yFiles.values()) {
    // A file blob must be a raster image — the same allow-list the binding
    // applies before a blob ever reaches Excalidraw's file store. An svg+xml /
    // text/html "image" is refused here so it can never be persisted either.
    // (Cast through the binding's own JSDoc param type — the shapes describe
    // the same untrusted wire object, just declared in two files.)
    if (!isAllowedImage(f as Parameters<typeof isAllowedImage>[0])) {
      return `disallowed file blob mime "${(f as BoardFile)?.mimeType}"`
    }
  }
  return null
}

/**
 * Apply an untrusted Yjs update to a whiteboard `ydoc` — but only if the
 * resulting scene is well-formed and safe. Mirrors ydoc.js::applyRemoteUpdate:
 * try on the shadow, validate, then apply to the live doc (Yjs updates are
 * idempotent + commutative, so the two stay in lock-step). Drop + resync on any
 * failure so a single hostile frame can never poison the validator that follows.
 */
export function applyRemoteBoardUpdate(ctx: BoardYContext, update: Uint8Array): ApplyBoardUpdateResult {
  const { ydoc, shadow } = ctx
  try {
    Y.applyUpdate(shadow, update, REMOTE_ORIGIN)
  } catch (err) {
    resyncBoardShadow(ctx)
    return { applied: false, reason: `undecodable update: ${(err as Error)?.message || err}` }
  }
  const bad = validateBoardMaps(shadow.getMap(ELEMENTS_KEY), shadow.getMap(FILES_KEY))
  if (bad) {
    resyncBoardShadow(ctx)
    return { applied: false, reason: bad }
  }
  try {
    Y.applyUpdate(ydoc, update, REMOTE_ORIGIN)
  } catch (err) {
    resyncBoardShadow(ctx)
    return { applied: false, reason: `apply failed: ${(err as Error)?.message || err}` }
  }
  return { applied: true }
}

/** Discard the shadow's state and rebuild it from the live document. */
export function resyncBoardShadow(ctx: BoardYContext): Y.Doc {
  const fresh = new Y.Doc()
  Y.applyUpdate(fresh, Y.encodeStateAsUpdate(ctx.ydoc), REMOTE_ORIGIN)
  ctx.shadow = fresh
  return fresh
}

/**
 * Create the { ydoc, shadow, applyUpdate } context a YP2PCollabSession needs for
 * a whiteboard. `applyUpdate` is the seam that lets the docs P2P session validate
 * an Excalidraw scene instead of a ProseMirror document — see yP2PSession.js.
 */
export function createBoardYContext(ydoc: Y.Doc = new Y.Doc()): BoardYContext {
  // Touch the shared types so they exist (and replicate) from the start.
  ydoc.getMap(ELEMENTS_KEY)
  ydoc.getMap(FILES_KEY)
  const ctx: BoardYContext = { ydoc, shadow: new Y.Doc(), applyUpdate: applyRemoteBoardUpdate }
  // Keep the shadow in lock-step with LOCAL edits too, so it never lags behind.
  ydoc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE_ORIGIN) return // already applied to the shadow
    try { Y.applyUpdate(ctx.shadow, update, REMOTE_ORIGIN) } catch { resyncBoardShadow(ctx) }
  })
  return ctx
}

// ── Deterministic seeding (the local-hydration primitive) ────────────────────

/**
 * A stable 31-bit hash — identical rationale to ydoc.js::hash31. Deriving the
 * seed clientID from the seed CONTENT is what makes concurrent seeding safe: two
 * peers seeding the SAME scene mint byte-identical Yjs items (a no-op merge, one
 * copy); two peers seeding DIFFERENT scenes mint non-colliding items (both
 * survive — ugly but visible, never silently one-dropped).
 */
function hash31(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0) % 0x7fffffff || 1
}

/** Coerce a persisted whiteboard `content` blob into { elements[], files{} }. */
export function normalizeScene(content: unknown): BoardScene {
  const c = content && typeof content === 'object' ? content as Record<string, unknown> : {}
  const elements = Array.isArray(c.elements) ? c.elements as BoardElement[] : []
  const files = c.files && typeof c.files === 'object' && !Array.isArray(c.files)
    ? c.files as Record<string, BoardFile>
    : {}
  return { elements, files }
}

/**
 * Build the deterministic Yjs update that seeds a whiteboard from its persisted
 * scene (models.File.Content). Applied to an empty doc it reproduces the scene.
 */
export function seedBoardUpdateFromScene(scene: unknown): Uint8Array {
  const { elements, files } = normalizeScene(scene)
  const canonical = JSON.stringify({ elements, files })
  const seed = new Y.Doc()
  // Must be set before any content is created (item ids embed the client id).
  seed.clientID = hash31(canonical)
  const yEl = seed.getMap(ELEMENTS_KEY)
  const yFi = seed.getMap(FILES_KEY)
  seed.transact(() => {
    for (const el of elements) {
      if (el && typeof el === 'object' && typeof el.id === 'string') yEl.set(el.id, el)
    }
    for (const [id, f] of Object.entries(files)) {
      if (f && typeof f === 'object') yFi.set(id, f)
    }
  })
  return Y.encodeStateAsUpdate(seed)
}

/** True when the whiteboard's Y.Doc holds no scene yet (nothing to render). */
export function isBoardDocEmpty(ydoc: Y.Doc): boolean {
  return ydoc.getMap(ELEMENTS_KEY).size === 0 && ydoc.getMap(FILES_KEY).size === 0
}

/**
 * Read the whiteboard's Y.Doc back into a persistable scene { elements[], files{} }.
 * Elements come out in fractional-index order (Excalidraw's expectation).
 */
export function boardDocToScene(ydoc: Y.Doc): BoardScene {
  const elements = [...ydoc.getMap<BoardElement>(ELEMENTS_KEY).values()].sort((a, b) => {
    const ai = a?.index
    const bi = b?.index
    if (ai != null && bi != null) return ai < bi ? -1 : ai > bi ? 1 : 0
    if (ai != null) return -1
    if (bi != null) return 1
    return 0
  })
  const files: Record<string, BoardFile> = {}
  for (const [id, f] of ydoc.getMap<BoardFile>(FILES_KEY).entries()) files[id] = f
  return { elements, files }
}

// Re-exported so a caller building a room by hand keeps one import site.
export { encodeUpdateEnvelope, bytesToB64, b64ToBytes }
