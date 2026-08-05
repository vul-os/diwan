/**
 * src/lib/crdt/ydoc.js — the Yjs document layer for Docs (structure-aware sync).
 *
 * WHY YJS (and not the old text CRDT, and not raw ProseMirror steps)
 * ------------------------------------------------------------------
 * Docs used to sync collaborative edits as PLAIN TEXT: it diffed
 * `editor.getText()` and replayed the diff as deleteRange + insertContentAt at a
 * character offset. That transport is structurally incapable of carrying a
 * document: formatting and structure (bold, headings, tables, lists, images,
 * links) simply do not exist in `getText()`, and a plain-text offset does not
 * map to a ProseMirror position in a multi-block document — so a remote insert
 * could land inside the wrong node and corrupt the structure.
 *
 * The document is now a Y.XmlFragment kept in lock-step with the ProseMirror
 * document by y-prosemirror's ySyncPlugin. Remote changes arrive as Yjs updates
 * and are turned into ProseMirror TRANSACTIONS with real positions — never text
 * offsets — so formatting and structure propagate, and a remote change can never
 * be applied at a wrong offset. Yjs is a CRDT, so it converges with NO central
 * authority — which is exactly what Office's collaboration model requires: the
 * document rides the E2E-encrypted peer-to-peer room (yP2PSession.js) where any
 * relay is content-blind and could not possibly rebase anything.
 *
 * (ProseMirror steps — prosemirror-collab — were the alternative. They need a
 * central authority to assign versions and rebase concurrent steps. Office has
 * no central document server at all: the p2p path is encrypted end-to-end, so
 * there is nowhere to run an authority. Steps would mean writing an OT server
 * per document — the very thing Office deliberately does not have. Yjs needs
 * none of it: peers converge on their own.)
 *
 * WIRE FORMAT (v1) — a peer-to-peer document update is the envelope:
 *
 *     { y: 1, u: "<base64 Yjs update>" }
 *
 * The `y` version tag makes the format explicit and lets a reader tell a Yjs
 * envelope from a legacy RGA TextOp ({k,id,p,v,t}) — see isYEnvelope /
 * isLegacyTextPayload and the local seed/hydration in DocsEditor.jsx.
 *
 * SECURITY — every byte here is UNTRUSTED
 * ---------------------------------------
 * An update arrives from a peer, a relay, or a persisted op log that a hostile
 * peer may have poisoned. Two things must never happen: (1) a malformed update
 * throwing inside the remote-op handler (the same fail-open class as the WAVE-56
 * TextCRDT ingress bug: a throw in the SSE handler kills the editor, and because
 * the op is persisted it re-kills every future joiner), and (2) a well-formed
 * Yjs update that encodes a document ProseMirror cannot render (an unknown node
 * type makes y-prosemirror throw while building the view) or that smuggles a
 * dangerous attribute (a javascript: link, a script-bearing SVG image src).
 *
 * So ingress is FAIL-CLOSED, exactly like the Sheets chart/pivot clamps:
 *   • decodeUpdateEnvelope  — shape + base64 + size checked; bad → null.
 *   • applyRemoteUpdate     — applies to a SHADOW doc first, converts that to a
 *     ProseMirror document against the real schema, and validates it. Only if it
 *     is renderable and clean does it touch the live document. A rejected update
 *     is DROPPED; the live doc is never left half-applied and never throws.
 */

import * as Y from 'yjs'
import { Node as PMNode, type Schema } from '@tiptap/pm/model'
import {
  prosemirrorJSONToYXmlFragment,
  yXmlFragmentToProsemirrorJSON,
} from 'y-prosemirror'

/** Untrusted ProseMirror-JSON-shaped node — see validateDocJSON below. */
export type PMJSON = {
  type?: string
  text?: string
  attrs?: Record<string, unknown>
  marks?: Array<{ type?: string; attrs?: Record<string, unknown> }>
  content?: PMJSON[]
  [key: string]: unknown
}

/** The XmlFragment key inside the Y.Doc that holds the ProseMirror document. */
export const Y_FRAGMENT = 'prosemirror'

/** Envelope format version. Bump only on a breaking wire change. */
export const Y_ENVELOPE_VERSION = 1

/**
 * Transaction origin tag for updates that came from a REMOTE peer. The sessions
 * apply remote updates with this origin so their own `ydoc.on('update')` handler
 * does not echo them back out (and so y-prosemirror's undo manager does not put
 * a peer's edit into the local user's undo stack).
 */
export const REMOTE_ORIGIN = 'vulos-remote'

/** Origin tag for the one-time seed of a document's initial content. */
export const SEED_ORIGIN = 'vulos-seed'

// ── Bounds (fail-closed) ────────────────────────────────────────────────────
// A single peer-to-peer update must fit well inside the fabric's per-frame data
// cap (256 KiB, see src/lib/collab/webrtc/fabric.js MAX_PAYLOAD_BYTES) once base64-inflated
// (+33%). Oversized frames are dropped by the transport, so we bound here first.
export const MAX_UPDATE_BYTES = 128 * 1024
// A snapshot is the whole compacted document; bounded so a state-vector resync
// answer stays within the transport's payload cap.
export const MAX_SNAPSHOT_BYTES = 1024 * 1024
// Structural ceilings on a document an untrusted peer may hand us. Generous for
// any real document; they exist so a hostile peer cannot ship a billion-node
// tree that wedges the renderer.
const MAX_DOC_NODES = 100000
const MAX_DOC_TEXT_CHARS = 8 * 1024 * 1024

// Image sources we will render. Mirrors the local insert gate (docsImage.js):
// raster only — an SVG (even as a data: URI) can carry script, and a
// javascript:/vbscript: URL must never reach an attribute.
const SAFE_IMAGE_SRC = /^(https?:\/\/|\/|data:image\/(png|jpe?g|gif|webp|bmp|avif);base64,)/i
// Link protocols we will render (TipTap's Link renders href verbatim).
const SAFE_HREF = /^(https?:|mailto:|tel:|ftp:|\/|#|\.\/|\.\.\/)/i
const UNSAFE_URL = /^\s*(javascript|data|vbscript|file):/i

// ── base64 (browser + node/jsdom, no Buffer dependency) ─────────────────────

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/

/** Uint8Array → base64. */
export function bytesToB64(bytes: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000 // avoid blowing the argument limit on large updates
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[])
  }
  return btoa(bin)
}

/** base64 → Uint8Array. Returns null on anything that is not clean base64. */
export function b64ToBytes(s: unknown): Uint8Array | null {
  if (typeof s !== 'string' || s.length === 0) return null
  if (s.length % 4 !== 0 || !B64_RE.test(s)) return null
  try {
    const bin = atob(s)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

// ── Envelopes ───────────────────────────────────────────────────────────────

export type UpdateEnvelope = { y: typeof Y_ENVELOPE_VERSION; u: string }

/** Wrap a raw Yjs update as the wire envelope. */
export function encodeUpdateEnvelope(update: Uint8Array): UpdateEnvelope {
  return { y: Y_ENVELOPE_VERSION, u: bytesToB64(update) }
}

/** True iff `o` looks like a Yjs envelope of a version we understand. */
export function isYEnvelope(o: unknown): o is UpdateEnvelope {
  return !!o && typeof o === 'object' && (o as Record<string, unknown>).y === Y_ENVELOPE_VERSION && typeof (o as Record<string, unknown>).u === 'string'
}

/**
 * True iff `o` is a LEGACY RGA TextOp ({k,id,p,v,t}) or a legacy CRDT snapshot
 * ({nodes:[…]}) — the pre-Yjs format. Used by the migration path to recognise
 * (and deliberately ignore) a pre-Yjs op log when hydrating a legacy document.
 */
export function isLegacyTextPayload(o: unknown): boolean {
  if (!o || typeof o !== 'object') return false
  const r = o as Record<string, unknown>
  if (typeof r.k === 'number' && (r.k === 1 || r.k === 2)) return true
  if (Array.isArray(r.nodes)) return true
  return false
}

/**
 * Envelope → raw update bytes, or null when the payload is not something we are
 * willing to feed to Yjs. FAIL-CLOSED: shape, base64 validity and size are all
 * checked here, at the ingress boundary, before any CRDT state is touched.
 *
 * @param env  untrusted payload from a peer / relay / persisted op log
 */
export function decodeUpdateEnvelope(env: unknown, maxBytes = MAX_UPDATE_BYTES): Uint8Array | null {
  if (!isYEnvelope(env)) return null
  // Reject before decoding: base64 inflates by 4/3, so cap the encoded length.
  if (env.u.length > Math.ceil((maxBytes * 4) / 3) + 4) return null
  const bytes = b64ToBytes(env.u)
  if (!bytes || bytes.length === 0 || bytes.length > maxBytes) return null
  return bytes
}

// ── Document validation (the untrusted-content clamp) ────────────────────────

/**
 * Walk a ProseMirror JSON document and reject anything a hostile peer could use
 * to escape sanitisation or wedge the renderer. Returns null when clean, or a
 * string reason when the document must be refused.
 *
 * This is deliberately a REJECT (not a strip): a legitimate peer never produces
 * these — every local insert path already clamps images (docsImage.js) and
 * sanitises imported HTML (lib/sanitize.js) — so the only producer of a bad node
 * is a hostile one, and dropping its whole update is the fail-closed answer. A
 * partial strip would leave the two peers' documents divergent, which is exactly
 * the class of bug this whole change exists to kill.
 */
export function validateDocJSON(json: unknown): string | null {
  let nodes = 0
  let textChars = 0
  const stack: unknown[] = [json]
  while (stack.length) {
    const raw = stack.pop()
    if (!raw || typeof raw !== 'object') return 'malformed node'
    const n = raw as PMJSON
    if (++nodes > MAX_DOC_NODES) return 'document exceeds node ceiling'
    if (typeof n.text === 'string') {
      textChars += n.text.length
      if (textChars > MAX_DOC_TEXT_CHARS) return 'document exceeds text ceiling'
    }
    const attrs = n.attrs
    if (attrs && typeof attrs === 'object') {
      // Images: raster sources only (the same gate as the local insert path).
      if (n.type === 'image' && attrs.src != null) {
        const src = String(attrs.src)
        if (!SAFE_IMAGE_SRC.test(src)) return 'image src not allowed'
      }
      // Any attribute that ends up in an href/src must not be a script URL.
      for (const key of ['href', 'src']) {
        const v = attrs[key]
        if (v != null && UNSAFE_URL.test(String(v)) && !(n.type === 'image' && key === 'src')) {
          return `unsafe ${key}`
        }
      }
    }
    for (const m of n.marks || []) {
      if (!m || typeof m !== 'object') return 'malformed mark'
      const href = m.attrs?.href
      if (href != null) {
        const h = String(href)
        if (UNSAFE_URL.test(h) || !SAFE_HREF.test(h)) return 'unsafe link href'
      }
    }
    for (const c of n.content || []) stack.push(c)
  }
  return null
}

/**
 * Convert a Y.XmlFragment to a ProseMirror document against `schema`, and check
 * that it is renderable AND clean. Returns { ok, json, reason }.
 *
 * PMNode.fromJSON throws on an unknown node/mark type — which is precisely what
 * a hostile peer would inject to crash y-prosemirror's view rebuild — and
 * node.check() catches a tree that violates the schema's content expressions
 * (e.g. a table row outside a table). Both are caught here, before the update is
 * allowed anywhere near the live document.
 */
export type FragmentCheckResult =
  | { ok: true; json: Record<string, unknown> }
  | { ok: false; reason: string; json?: Record<string, unknown> }

export function checkFragmentRenderable(fragment: Y.XmlFragment, schema: Schema): FragmentCheckResult {
  let json: Record<string, unknown>
  try {
    json = yXmlFragmentToProsemirrorJSON(fragment)
  } catch (err) {
    return { ok: false, reason: `unreadable fragment: ${(err as Error)?.message || err}` }
  }
  const bad = validateDocJSON(json)
  if (bad) return { ok: false, reason: bad, json }
  let node: InstanceType<typeof PMNode>
  try {
    node = PMNode.fromJSON(schema, json)
    node.check()
  } catch (err) {
    return { ok: false, reason: `not renderable: ${(err as Error)?.message || err}`, json }
  }
  // Hand back CANONICAL ProseMirror JSON (node.toJSON()), not y-prosemirror's
  // raw conversion — the latter emits `attrs: {}` on attribute-less marks, which
  // is semantically identical but not byte-identical to what the editor produces.
  // Callers compare this against editor.getJSON() (and persist it), so it must be
  // the same shape.
  return { ok: true, json: node.toJSON() }
}

// ── Deterministic seeding (the migration primitive) ──────────────────────────

/**
 * A stable 31-bit hash. Used to derive the SEED client id from the seed content
 * itself, which is what makes seeding safe when two peers seed concurrently:
 *
 *   • Same content  → same client id → byte-identical seed update → the two
 *     seeds are the SAME Yjs items, and merging them is a no-op (Yjs dedups by
 *     (client, clock)). Both peers converge on one copy of the document.
 *   • Different content (a peer with a stale copy) → different client id → the
 *     items cannot collide, so the worst case is that both versions survive the
 *     merge. Ugly, visible, recoverable. If instead we had used a FIXED client
 *     id, two different seeds would mint items with the SAME (client, clock) and
 *     Yjs would silently keep one and drop the other — a divergence we could
 *     never detect. Content-derived ids make the bad case loud instead of silent.
 */
function hash31(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0) % 0x7fffffff || 1 // never 0 (Yjs treats 0 as unset)
}

/**
 * Build the deterministic Yjs update that seeds a document from its existing
 * ProseMirror JSON — i.e. the authoritative content the document has ALWAYS been
 * saved as (models.File.Content). This is the whole migration: an existing doc's
 * content is not converted from the old op log (which never carried formatting
 * in the first place), it is re-derived from the document itself.
 *
 * @param docJSON  ProseMirror document JSON
 * @returns a Yjs update that, applied to an empty doc, reproduces it
 */
export function seedUpdateFromPMJSON(schema: Schema, docJSON: Record<string, unknown>): Uint8Array {
  const canonical = JSON.stringify(docJSON)
  const seed = new Y.Doc()
  // Must be set before any content is created (item ids embed the client id).
  seed.clientID = hash31(canonical)
  prosemirrorJSONToYXmlFragment(schema, docJSON, seed.getXmlFragment(Y_FRAGMENT))
  return Y.encodeStateAsUpdate(seed)
}

/** True when the doc's fragment holds no content yet (nothing to render). */
export function isFragmentEmpty(ydoc: Y.Doc): boolean {
  const frag = ydoc.getXmlFragment(Y_FRAGMENT)
  return frag.length === 0
}

// ── The guarded apply (every remote byte goes through here) ──────────────────

/**
 * Apply an untrusted Yjs update to `ydoc` — but only if the resulting document
 * is renderable and clean.
 *
 * The update is first applied to a SHADOW Y.Doc that mirrors the live one. If
 * the shadow then converts to a valid ProseMirror document, the very same update
 * is applied to the live doc (Yjs updates are idempotent + commutative, so the
 * two docs stay in lock-step). If it does not, the update is dropped and the
 * shadow is rebuilt from the live doc, so one hostile frame cannot poison the
 * validator for the frames that follow.
 *
 * @param ctx  { ydoc, shadow, schema }
 */
export type YContext = { ydoc: Y.Doc; shadow: Y.Doc; schema: Schema }
export type ApplyRemoteUpdateResult = { applied: boolean; reason?: string }

export function applyRemoteUpdate(ctx: YContext, update: Uint8Array): ApplyRemoteUpdateResult {
  const { ydoc, shadow, schema } = ctx
  try {
    Y.applyUpdate(shadow, update, REMOTE_ORIGIN)
  } catch (err) {
    // Malformed/garbage bytes: Yjs throws while decoding. Fail closed — and note
    // the shadow may now be partially updated, so rebuild it.
    resyncShadow(ctx)
    return { applied: false, reason: `undecodable update: ${(err as Error)?.message || err}` }
  }
  const check = checkFragmentRenderable(shadow.getXmlFragment(Y_FRAGMENT), schema)
  if (!check.ok) {
    resyncShadow(ctx)
    return { applied: false, reason: check.reason }
  }
  try {
    Y.applyUpdate(ydoc, update, REMOTE_ORIGIN)
  } catch (err) {
    resyncShadow(ctx)
    return { applied: false, reason: `apply failed: ${(err as Error)?.message || err}` }
  }
  return { applied: true }
}

/** Discard the shadow's state and rebuild it from the live document. */
export function resyncShadow(ctx: YContext): Y.Doc {
  const fresh = new Y.Doc()
  Y.applyUpdate(fresh, Y.encodeStateAsUpdate(ctx.ydoc), REMOTE_ORIGIN)
  ctx.shadow = fresh
  return fresh
}

/**
 * Create the { ydoc, shadow, schema } context a session needs. The shadow is the
 * validator's sandbox: it always holds exactly what the live doc holds, so a
 * candidate update can be tried on it in O(update) instead of re-cloning the
 * whole document on every remote frame.
 */
export function createYContext(schema: Schema, ydoc: Y.Doc = new Y.Doc()): YContext {
  const ctx: YContext = { ydoc, shadow: new Y.Doc(), schema }
  // Keep the shadow in lock-step with LOCAL edits too, so it never lags behind.
  ydoc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE_ORIGIN) return // already applied to the shadow
    try { Y.applyUpdate(ctx.shadow, update, REMOTE_ORIGIN) } catch { resyncShadow(ctx) }
  })
  return ctx
}

export { Y }
