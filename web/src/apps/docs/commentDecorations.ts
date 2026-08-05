/**
 * commentDecorations.js — WAVE-45
 *
 * Comment-anchor highlighting + click-to-jump for the Docs editor.
 *
 * Comments (OFFICE-26) are anchored to a ProseMirror position range
 * `anchor.from` / `anchor.to` (captured from `editor.state.selection` when the
 * comment was created — these are PM doc positions, not plain-text char
 * offsets). Historically nothing rendered them in the doc body; a comment was
 * only visible in the side panel. This extension:
 *
 *   1. Renders a subtle inline highlight over each open comment's anchor range
 *      via ProseMirror decorations.
 *   2. Maps those decorations through document edits so the highlight follows
 *      the text as it moves (insertions/deletions before the anchor shift it).
 *   3. Detects when an anchor's text was fully deleted (range collapsed) and
 *      surfaces it as "orphaned" instead of crashing or highlighting nothing.
 *   4. Enables click-to-jump both ways: clicking a highlight fires an
 *      `onActivate(commentId)` callback (panel focuses the comment); the editor
 *      exposes helpers to scroll+flash a given comment's anchor.
 *
 * How anchors map to decorations and survive edits
 * -------------------------------------------------
 * Each render we build a fresh `DecorationSet` from the current comment list,
 * clamping every `[from,to]` to the live document size. On every transaction we
 * `decorations.map(tr.mapping, tr.doc)` — ProseMirror's position mapping — so a
 * highlight tracks its text through concurrent edits without us recomputing
 * offsets. We recompute from scratch (via the meta channel) only when the
 * comment list itself changes (add/resolve/delete) or a jump/flash is requested.
 *
 * Best-effort remap-back: after mapping, `readMappedRanges(view)` reports the
 * current live `[from,to]` for each decoration so the caller can persist the
 * moved positions back into the CommentStore (`remapAnchors`). A range that
 * collapsed to zero width is reported as `null` → the store marks it orphaned.
 *
 * RE-ANCHORING UNDER COLLABORATION
 * --------------------------------
 * Position mapping alone is NOT enough once a remote peer can change the
 * document. y-prosemirror applies a remote change by REPLACING the whole
 * document (see its sync-plugin `_typeChanged`: `tr.replace(0, doc.content.size,
 * …)`), so every decoration mapped through that transaction collapses and the
 * highlight is simply lost — the comment would silently stop pointing at its
 * text.
 *
 * So when collaboration is active we ALSO hold each anchor as a Yjs RELATIVE
 * POSITION — a position expressed against the CRDT's own item ids rather than a
 * numeric offset. It survives any concurrent edit by construction (it is what
 * y-prosemirror itself uses to restore the local selection across a remote
 * change). On a remote transaction we rebuild the decorations by resolving those
 * relative positions against the new document, instead of mapping the old ones.
 * An anchor whose text a peer deleted resolves to nothing and is reported as
 * orphaned, exactly as a locally-deleted one is.
 */

import { Extension } from '@tiptap/react'
import type { Editor } from '@tiptap/react'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type DecorationAttrs } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import {
  ySyncPluginKey,
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  type ProsemirrorBinding,
} from 'y-prosemirror'
import type * as Y from 'yjs'
import type { Comment, CommentAnchor } from '../../lib/crdt/comments.js'

// ---------------------------------------------------------------------------
// Plugin state shape
// ---------------------------------------------------------------------------

/** A comment anchor's [from,to] expressed as Yjs relative positions — see the
 *  RE-ANCHORING note above. */
interface RelativeAnchor {
  from: Y.RelativePosition
  to: Y.RelativePosition
}

export interface CommentPluginState {
  comments: Comment[]
  activeId: string | null
  flashId: string | null
  decorations: DecorationSet
  // commentId → { from: Y.RelativePosition, to: Y.RelativePosition }
  // Only populated when the document is collaborative. See the
  // RE-ANCHORING note in the header.
  rel: Map<string, RelativeAnchor>
}

export const COMMENT_PLUGIN_KEY = new PluginKey<CommentPluginState>('commentDecorations')

// Meta payloads the plugin understands.
//   { comments: [...] }          → rebuild decorations from the comment list
//   { flash: commentId }         → add a transient flash class to that anchor
//   { clearFlash: commentId }    → remove the transient flash class
export const COMMENT_META = 'commentDecorations'

export interface CommentDecorationsMeta {
  comments?: Comment[]
  activeId?: string | null
  flash?: string
  clearFlash?: string
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests — no ProseMirror runtime needed)
// ---------------------------------------------------------------------------

/**
 * Clamp a comment anchor range to a valid, non-empty span inside a doc of
 * `docSize` (ProseMirror doc.content.size). Returns null when the anchor is
 * missing, orphaned, not a text range, or collapses to nothing after clamping
 * (its text was deleted) — the caller treats null as "orphaned, don't render".
 */
export function clampAnchor(
  anchor: CommentAnchor | null | undefined,
  docSize: number,
): { from: number; to: number } | null {
  if (!anchor || anchor.orphaned) return null
  if (anchor.type !== 'text_range') return null
  if (typeof anchor.from !== 'number' || typeof anchor.to !== 'number') return null
  // Positions 1..docSize are valid content positions (0 is before the doc).
  let from = Math.max(1, Math.min(anchor.from, docSize))
  let to = Math.max(1, Math.min(anchor.to, docSize))
  if (to < from) [from, to] = [to, from]
  if (to <= from) return null // collapsed → anchored text is gone
  return { from, to }
}

export interface CommentDecorationSpec {
  commentId: string
  from: number
  to: number
  resolved: boolean
}

export interface CommentDecorationSpecs {
  specs: CommentDecorationSpec[]
  orphans: string[]
}

/**
 * Build the plain decoration descriptors for a comment list against a doc of
 * `docSize`. Returns `{ specs, orphans }` where specs is an array of
 * `{ commentId, from, to, resolved }` for renderable anchors and orphans is an
 * array of commentIds whose anchor collapsed. Kept separate from Decoration
 * construction so the mapping logic is unit-testable without pm-view.
 *
 * Resolved comments are still described (so a resolved highlight can render
 * more faintly) but callers may choose to skip them.
 */
export function buildDecorationSpecs(
  comments: Comment[] | null | undefined,
  docSize: number,
): CommentDecorationSpecs {
  const specs: CommentDecorationSpec[] = []
  const orphans: string[] = []
  for (const c of comments || []) {
    if (!c || !c.anchor) continue
    const range = clampAnchor(c.anchor, docSize)
    if (!range) {
      // Only report as orphaned if it *looks* like a text anchor that lost its
      // text — non-text anchors (slide/cell) simply aren't rendered here.
      if (c.anchor.type === 'text_range') orphans.push(c.id)
      continue
    }
    specs.push({
      commentId: c.id,
      from: range.from,
      to: range.to,
      resolved: c.state === 'resolved',
    })
  }
  return { specs, orphans }
}

// ---------------------------------------------------------------------------
// Decoration construction (needs pm-view Decoration)
// ---------------------------------------------------------------------------

function specToDecoration(spec: CommentDecorationSpec, activeId: string | null): Decoration {
  const classes = ['comment-highlight']
  if (spec.resolved) classes.push('comment-highlight-resolved')
  if (spec.commentId === activeId) classes.push('comment-highlight-active')
  return Decoration.inline(
    spec.from,
    spec.to,
    {
      class: classes.join(' '),
      'data-comment-id': spec.commentId,
    },
    // inclusiveStart/End:false so typing at the very edge of a highlight does
    // not extend the comment span (matches editor intuition).
    { inclusiveStart: false, inclusiveEnd: false },
  )
}

function buildDecorationSet(
  doc: PMNode,
  comments: Comment[] | null | undefined,
  activeId: string | null,
  flashId: string | null,
): DecorationSet {
  const { specs } = buildDecorationSpecs(comments, doc.content.size)
  const decos: Decoration[] = []
  for (const spec of specs) {
    // Skip resolved highlights entirely unless they're the active/flashed one
    // (resolved comments shouldn't clutter the page, but a click-jump to one
    // should still show where it was).
    if (spec.resolved && spec.commentId !== activeId && spec.commentId !== flashId) continue
    try {
      const d = specToDecoration(spec, activeId)
      decos.push(d)
      if (spec.commentId === flashId) {
        // A second, whole-range decoration carrying the flash class so the CSS
        // animation applies without disturbing the base highlight class set.
        decos.push(Decoration.inline(spec.from, spec.to, { class: 'comment-highlight-flash' }))
      }
    } catch {
      // Defensive: a bad range shouldn't nuke the whole set.
    }
  }
  return DecorationSet.create(doc, decos)
}

// ---------------------------------------------------------------------------
// Read mapped ranges back out (for best-effort persist to the store)
// ---------------------------------------------------------------------------

/** Loose shape covering both places a Decoration's DOM attrs turn up across
 *  pm-view versions/kinds — see decorationCommentId below. Neither `type` nor
 *  a typed `spec.attrs` is part of Decoration's public .d.ts (its `spec`
 *  getter is `any`), so this is a local cast helper, not a trusted type. */
interface DecorationLike {
  type?: { attrs?: DecorationAttrs }
  spec?: { attrs?: DecorationAttrs }
}

/**
 * Read the comment id off a ProseMirror decoration. Inline decorations expose
 * their DOM attrs at `deco.type.attrs`; some pm versions / decoration kinds
 * surface them under `deco.spec.attrs`. Check both so callers don't depend on
 * the internal layout.
 */
export function decorationCommentId(deco: Decoration | null | undefined): string | null {
  const d = deco as unknown as DecorationLike | null | undefined
  return (
    d?.type?.attrs?.['data-comment-id'] ||
    d?.spec?.attrs?.['data-comment-id'] ||
    null
  )
}

/**
 * Given the plugin's current decoration set + the comment list, report the
 * live `[from,to]` for each comment (or null if its decoration disappeared /
 * collapsed). Used to feed CommentStore.remapAnchors so anchors survive edits
 * across reloads.
 */
export function readMappedRanges(
  decorationSet: DecorationSet,
  comments: Comment[] | null | undefined,
): Map<string, { from: number; to: number } | null> {
  const out = new Map<string, { from: number; to: number } | null>()
  const found = new Map<string, { from: number; to: number }>()
  // DecorationSet.find() returns all decorations; group by data-comment-id.
  const all = decorationSet.find()
  for (const d of all) {
    const id = decorationCommentId(d)
    if (!id) continue
    // Prefer the widest span if duplicated (base + flash).
    const prev = found.get(id)
    if (!prev || (d.to - d.from) > (prev.to - prev.from)) {
      found.set(id, { from: d.from, to: d.to })
    }
  }
  for (const c of comments || []) {
    if (!c?.anchor || c.anchor.type !== 'text_range') continue
    const r = found.get(c.id)
    if (r && r.to > r.from) out.set(c.id, { from: r.from, to: r.to })
    else out.set(c.id, null) // collapsed / removed → orphan
  }
  return out
}

// ---------------------------------------------------------------------------
// Collaborative re-anchoring (Yjs relative positions)
// ---------------------------------------------------------------------------

/** The plugin state y-prosemirror's ySyncPlugin installs — its own .d.ts types
 *  ySyncPluginKey as `PluginKey<any>`, so this is a local cast helper for the
 *  fields this module actually reads (see y-prosemirror's sync-plugin.js
 *  `state.init`, which is where this shape actually comes from). */
interface YSyncPluginState {
  type: Y.XmlFragment
  doc: Y.Doc
  binding: ProsemirrorBinding
}

/** The y-prosemirror binding for this editor, or null when collab is off. */
function yBinding(state: EditorState): YSyncPluginState | null {
  try {
    const ystate = ySyncPluginKey.getState(state) as unknown as YSyncPluginState | undefined
    if (!ystate || !ystate.binding || !ystate.type) return null
    return ystate
  } catch { return null }
}

/** True when this transaction is a remote peer's change applied by the sync plugin. */
export function isRemoteChange(tr: Transaction | null | undefined): boolean {
  try {
    const change = tr?.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined
    return !!change?.isChangeOrigin
  } catch { return false }
}

/**
 * Convert each decoration's [from,to] into Yjs RELATIVE positions, so the anchor
 * can be recovered after a remote change replaces the document. A no-op (returns
 * the previous map) when the document is not collaborative.
 */
function captureRelativeAnchors(
  state: EditorState,
  decorationSet: DecorationSet,
  prev: Map<string, RelativeAnchor>,
): Map<string, RelativeAnchor> {
  const ystate = yBinding(state)
  if (!ystate) return prev
  const rel = new Map<string, RelativeAnchor>()
  try {
    for (const d of decorationSet.find()) {
      const id = decorationCommentId(d)
      if (!id || rel.has(id)) continue
      rel.set(id, {
        from: absolutePositionToRelativePosition(d.from, ystate.type, ystate.binding.mapping) as Y.RelativePosition,
        to: absolutePositionToRelativePosition(d.to, ystate.type, ystate.binding.mapping) as Y.RelativePosition,
      })
    }
  } catch {
    return prev  // binding not ready — keep what we had
  }
  return rel
}

/**
 * Rebuild the decoration set from the relative anchors after a remote change.
 * Returns null when there is nothing to rebuild from (caller falls back).
 *
 * An anchor whose text the peer deleted resolves to null / a collapsed range and
 * is dropped — the comment becomes orphaned, which is the same outcome as a local
 * deletion and is what the panel already knows how to show.
 */
function rebuildFromRelativeAnchors(state: EditorState, old: CommentPluginState): CommentPluginState | null {
  const ystate = yBinding(state)
  if (!ystate || !old.rel || old.rel.size === 0) return null
  const decos: Decoration[] = []
  try {
    for (const [id, r] of old.rel) {
      const from = relativePositionToAbsolutePosition(ystate.doc, ystate.type, r.from, ystate.binding.mapping)
      const to = relativePositionToAbsolutePosition(ystate.doc, ystate.type, r.to, ystate.binding.mapping)
      if (from == null || to == null || to <= from) continue   // orphaned
      const size = state.doc.content.size
      if (from < 0 || to > size) continue
      const comment = (old.comments || []).find((c) => c.id === id)
      decos.push(specToDecoration({
        commentId: id,
        from,
        to,
        resolved: comment?.state === 'resolved',
      }, old.activeId))
    }
  } catch {
    return null
  }
  return { ...old, decorations: DecorationSet.create(state.doc, decos) }
}

/**
 * Return the comment id whose highlight covers the editor's current caret
 * position, or null. Used for the keyboard "focus comment at cursor" shortcut.
 */
export function commentIdAtSelection(editor: Editor | null | undefined): string | null {
  try {
    // Relies on the catch below for a null/not-ready editor, same as the
    // original untyped helper — this cast doesn't change that behavior.
    const state = (editor as Editor).state
    const pluginState = COMMENT_PLUGIN_KEY.getState(state)
    if (!pluginState) return null
    const pos = state.selection.from
    const decos = pluginState.decorations.find(pos, pos)
    for (const d of decos) {
      const id = decorationCommentId(d)
      if (id) return id
    }
  } catch { /* editor not ready */ }
  return null
}

// ---------------------------------------------------------------------------
// The TipTap extension
// ---------------------------------------------------------------------------

export interface CommentDecorationsExtensionOptions {
  /** called when a highlight is clicked/keyboard-activated — the panel should
   *  focus that comment. */
  onActivate?: (commentId: string) => void
}

export function createCommentDecorationsExtension(opts: CommentDecorationsExtensionOptions = {}) {
  const onActivate = opts.onActivate || (() => {})

  return Extension.create({
    name: 'commentDecorations',

    addProseMirrorPlugins() {
      return [
        new Plugin<CommentPluginState>({
          key: COMMENT_PLUGIN_KEY,
          state: {
            init(): CommentPluginState {
              return {
                comments: [],
                activeId: null,
                flashId: null,
                decorations: DecorationSet.empty,
                // commentId → { from: Y.RelativePosition, to: Y.RelativePosition }
                // Only populated when the document is collaborative. See the
                // RE-ANCHORING note in the header.
                rel: new Map(),
              }
            },
            apply(tr, old, _oldState, newState) {
              const meta = tr.getMeta(COMMENT_META) as CommentDecorationsMeta | undefined
              if (meta) {
                const comments = meta.comments !== undefined ? meta.comments : old.comments
                const activeId = meta.activeId !== undefined ? meta.activeId : old.activeId
                let flashId = old.flashId
                if (meta.flash !== undefined) flashId = meta.flash
                if (meta.clearFlash !== undefined && old.flashId === meta.clearFlash) flashId = null
                const decorations = buildDecorationSet(newState.doc, comments, activeId, flashId)
                return {
                  comments,
                  activeId,
                  flashId,
                  decorations,
                  rel: captureRelativeAnchors(newState, decorations, old.rel),
                }
              }
              if (!tr.docChanged) return old

              // A REMOTE peer's change: y-prosemirror replaced the whole document,
              // so mapping the old decorations through this transaction would
              // simply delete them. Rebuild from the CRDT-relative anchors, which
              // track the text itself rather than a numeric offset.
              if (isRemoteChange(tr)) {
                const rebuilt = rebuildFromRelativeAnchors(newState, old)
                if (rebuilt) return rebuilt
                // No relative anchors yet (e.g. the very first remote frame before
                // any comment was rendered) — fall through to plain mapping.
              }

              // Local edit: map existing decorations through it so highlights
              // follow their text, then refresh the relative anchors from the
              // mapped positions.
              const decorations = old.decorations.map(tr.mapping, tr.doc)
              return {
                ...old,
                decorations,
                rel: captureRelativeAnchors(newState, decorations, old.rel),
              }
            },
          },
          props: {
            decorations(state) {
              return COMMENT_PLUGIN_KEY.getState(state)?.decorations
            },
            handleClick(view, _pos, event) {
              // Click-to-jump (highlight → panel). Walk up from the click target
              // to find a decorated span carrying a comment id.
              let el = event.target as Node | null
              while (el && el !== view.dom) {
                if (el instanceof Element) {
                  const id = el.getAttribute('data-comment-id')
                  if (id) {
                    onActivate(id)
                    return false // don't preventDefault — let caret placement work
                  }
                }
                el = el.parentElement
              }
              return false
            },
          },
        }),
      ]
    },
  })
}
