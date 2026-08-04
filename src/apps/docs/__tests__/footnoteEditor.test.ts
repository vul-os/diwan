/**
 * WAVE-45 — integration tests that drive a *real* TipTap editor with the
 * footnote + comment-decoration extensions to verify they wire up correctly:
 * insertion creates a ref + list entry, numbering decorations apply, and the
 * comment decoration plugin builds/maps highlights over a live document.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import type { Extensions } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { Decoration } from '@tiptap/pm/view'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import {
  FootnoteRef,
  FootnoteItem,
  FootnotesList,
  FootnoteNumberingExtension,
  scanFootnotes,
  numberFootnotesInHtml,
  collectFootnoteRefIds,
  computeFootnoteOrder,
} from '../footnotes.js'
import { exportToHtml } from '../docsExport.js'
import { saveAs } from 'file-saver'

vi.mock('file-saver', () => ({ saveAs: vi.fn() }))
import {
  createCommentDecorationsExtension,
  COMMENT_PLUGIN_KEY,
  COMMENT_META,
  decorationCommentId,
  commentIdAtSelection,
} from '../commentDecorations.js'
import type { CommentPluginState } from '../commentDecorations.js'

function makeEditor(extra: Extensions = []): Editor {
  return new Editor({
    extensions: [
      Document, Paragraph, Text,
      FootnoteRef, FootnoteItem, FootnotesList, FootnoteNumberingExtension,
      ...extra,
    ],
    content: '<p>Hello world</p>',
  })
}

// A returning lookup (rather than mutating an outer `let` from inside the
// descendants callback) — TS can't flow-narrow a variable mutated inside a
// nested function at the read site (same issue worked around elsewhere in
// this suite's conversions, e.g. equations.test.ts's findNodeByType).
function findFirstNodePos(doc: PMNode, typeName: string): { pos: number; size: number } | null {
  let found: { pos: number; size: number } | null = null
  doc.descendants((n, pos) => {
    if (found) return false
    if (n.type.name === typeName) { found = { pos, size: n.nodeSize } }
    return true
  })
  return found
}

/** The comment-decorations plugin's live state — throws if the extension
 *  somehow isn't active (it always is where this is called; this just
 *  satisfies PluginKey.getState()'s possibly-undefined return type). */
function commentPluginState(editor: Editor): CommentPluginState {
  const state = COMMENT_PLUGIN_KEY.getState(editor.state)
  if (!state) throw new Error('comment decorations plugin not active')
  return state
}

// Decoration's `.type.attrs` is not part of its public .d.ts (its `spec`
// getter is typed `any`) — a local cast helper, same as commentDecorations.ts's
// own DecorationLike for the identical untyped surface.
interface DecorationTypeAttrs {
  type?: { attrs?: Record<string, unknown> }
}
function decorationClass(d: Decoration): unknown {
  return (d as unknown as DecorationTypeAttrs).type?.attrs?.class
}

let editor: Editor | null = null
afterEach(() => { editor?.destroy(); editor = null })

describe('footnote insertion (live editor)', () => {
  it('insertFootnote adds an inline ref and a matching list item', () => {
    editor = makeEditor()
    editor.commands.setTextSelection(6) // between "Hello" and " world"
    editor.commands.insertFootnote()

    const { bodyRefIds, itemIds, listPos } = scanFootnotes(editor.state.doc)
    expect(bodyRefIds).toHaveLength(1)
    expect(itemIds).toHaveLength(1)
    expect(bodyRefIds[0]).toBe(itemIds[0]) // ref id matches its list entry
    expect(listPos).not.toBeNull()
  })

  it('multiple footnotes share one list and get sequential numbers', () => {
    editor = makeEditor()
    editor.commands.insertFootnote()
    editor.commands.focus('end')
    editor.commands.insertFootnote()

    const { bodyRefIds, itemIds } = scanFootnotes(editor.state.doc)
    expect(bodyRefIds).toHaveLength(2)
    expect(itemIds).toHaveLength(2)
    // Only one list node exists.
    let listCount = 0
    editor.state.doc.descendants((n) => { if (n.type.name === 'footnotesList') listCount++ })
    expect(listCount).toBe(1)

    // Numbering decorations are applied (data-fn-num on the rendered refs).
    const html = editor.view.dom.innerHTML
    expect(html).toContain('data-fn-num="1"')
    expect(html).toContain('data-fn-num="2"')
  })

  it('deleting a ref from the body removes its orphaned list item (sync plugin)', () => {
    editor = makeEditor()
    editor.commands.setTextSelection(6)
    editor.commands.insertFootnote()
    let scan = scanFootnotes(editor.state.doc)
    expect(scan.itemIds).toHaveLength(1)

    // Find the ref node and delete it.
    const ref = findFirstNodePos(editor.state.doc, 'footnoteRef')
    if (!ref) throw new Error('footnoteRef not found')
    editor.commands.deleteRange({ from: ref.pos, to: ref.pos + ref.size })

    scan = scanFootnotes(editor.state.doc)
    expect(scan.bodyRefIds).toHaveLength(0)
    // Orphaned list item (and now-empty list) should be gone.
    expect(scan.itemIds).toHaveLength(0)
    expect(scan.listPos).toBeNull()
  })
})

describe('footnote export numbering (WAVE-47)', () => {
  it('numberFootnotesInHtml bakes sequential numbers into refs and list items', () => {
    // Two footnotes; getHTML() carries structure with no numbers.
    const editor = makeEditor()
    editor.commands.setTextSelection(6)
    editor.commands.insertFootnote()
    editor.commands.focus('end')
    editor.commands.insertFootnote()

    const raw = editor.getHTML()
    // Cold HTML has the ids but no baked numbers.
    expect(raw).not.toContain('data-fn-num="1"')

    const numbered = numberFootnotesInHtml(raw)
    // Inline refs now carry 1 and 2 as attribute + text.
    expect(numbered).toContain('data-fn-num="1"')
    expect(numbered).toContain('data-fn-num="2"')
    // The visible marker text is sequential (not a "*"/"•" fallback).
    const refNums = Array.from(numbered.matchAll(/<sup[^>]*data-fn-id[^>]*>(\d+)<\/sup>/g))
      .map((m) => m[1])
    expect(refNums).toEqual(['1', '2'])
    // List items get numbered too.
    expect(numbered).toContain('class="footnote-num">1. ')
    expect(numbered).toContain('class="footnote-num">2. ')
  })

  it('export numbering matches in-editor computeFootnoteOrder', () => {
    const editor = makeEditor()
    editor.commands.setTextSelection(6)
    editor.commands.insertFootnote()
    editor.commands.focus('end')
    editor.commands.insertFootnote()

    const order = computeFootnoteOrder(collectFootnoteRefIds(editor.getJSON()))
    const numbers = Array.from(order.values())
    expect(numbers).toEqual([1, 2]) // sequential, matches the editor decorations
  })

  it('exportToHtml emits sequential footnote numbers in the saved HTML', () => {
    const editor = makeEditor()
    editor.commands.setTextSelection(6)
    editor.commands.insertFootnote()
    editor.commands.focus('end')
    editor.commands.insertFootnote()

    exportToHtml(editor, 'doc-with-footnotes')

    expect(saveAs).toHaveBeenCalled()
    const data = vi.mocked(saveAs).mock.calls.at(-1)?.[0]
    if (!(data instanceof Blob)) throw new Error('expected saveAs to be called with a Blob')
    // file-saver receives a Blob; pull its text back out. jsdom Blob supports .text().
    return data.text().then((html) => {
      expect(html).toContain('data-fn-num="1"')
      expect(html).toContain('data-fn-num="2"')
      const refNums = Array.from(html.matchAll(/<sup[^>]*data-fn-id[^>]*>(\d+)<\/sup>/g))
        .map((m) => m[1])
      expect(refNums).toEqual(['1', '2'])
    })
  })
})

describe('comment decorations (live editor)', () => {
  it('builds a highlight decoration for an anchored comment', () => {
    editor = makeEditor([createCommentDecorationsExtension({})])
    const comments = [{ id: 'c1', state: 'open', anchor: { type: 'text_range', from: 1, to: 6 } }]

    const tr = editor.state.tr
    tr.setMeta(COMMENT_META, { comments, activeId: null })
    editor.view.dispatch(tr)

    const decos = commentPluginState(editor).decorations.find()
    const found = decos.find((d) => decorationCommentId(d) === 'c1')
    expect(found).toBeTruthy()
    if (!found) throw new Error('decoration not found')
    expect(decorationClass(found)).toContain('comment-highlight')
  })

  it('maps the highlight through an edit so it follows its text', () => {
    editor = makeEditor([createCommentDecorationsExtension({})])
    const comments = [{ id: 'c1', state: 'open', anchor: { type: 'text_range', from: 7, to: 12 } }]
    editor.view.dispatch(editor.state.tr.setMeta(COMMENT_META, { comments, activeId: null }))

    const before = commentPluginState(editor).decorations
      .find().find((d) => decorationCommentId(d) === 'c1')
    if (!before) throw new Error('decoration not found (before)')

    // Insert 3 chars at the very start; the highlight should shift right by 3.
    editor.commands.insertContentAt(1, 'XXX')

    const after = commentPluginState(editor).decorations
      .find().find((d) => decorationCommentId(d) === 'c1')
    if (!after) throw new Error('decoration not found (after)')

    expect(after.from).toBe(before.from + 3)
    expect(after.to).toBe(before.to + 3)
  })

  it('commentIdAtSelection finds the comment covering the caret', () => {
    editor = makeEditor([createCommentDecorationsExtension({})])
    const comments = [{ id: 'c1', state: 'open', anchor: { type: 'text_range', from: 1, to: 6 } }]
    editor.view.dispatch(editor.state.tr.setMeta(COMMENT_META, { comments, activeId: null }))

    editor.commands.setTextSelection(3) // inside [1,6)
    expect(commentIdAtSelection(editor)).toBe('c1')

    editor.commands.setTextSelection(9) // outside the highlight
    expect(commentIdAtSelection(editor)).toBeNull()
  })
})
