/**
 * Structure-aware collaborative sync (Yjs + y-prosemirror) — the regression
 * suite for the bug this replaced.
 *
 * THE BUG: Docs synced collaborative edits as PLAIN TEXT. It diffed
 * editor.getText() and replayed the diff with deleteRange + insertContentAt at a
 * character offset. So (1) formatting and structure NEVER propagated — a peer's
 * bold/heading/table/list/image was invisible to everyone else — and (2) because
 * getText() emits no delimiters between block nodes, the offset did not address a
 * position in the document at all: a remote insert could land inside the wrong
 * node and corrupt the structure. There was no test that would have caught either.
 *
 * These are those tests. Every assertion below is on the DOCUMENT (ProseMirror
 * JSON), never on getText() — getText() is precisely the projection that hid the
 * bug. Two real TipTap editors are wired to each other through the same validated
 * ingress the sessions use (applyRemoteUpdate), so what is exercised is the real
 * remote-apply path, not a mock of it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Editor } from '@tiptap/react'
import type { JSONContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import TextStyle from '@tiptap/extension-text-style'
import Underline from '@tiptap/extension-underline'
import Highlight from '@tiptap/extension-highlight'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import type { Schema } from '@tiptap/pm/model'
import { DocImage } from '../docsImage.js'
import { YCollab } from '../collabExtension.js'
import {
  createCommentDecorationsExtension,
  COMMENT_PLUGIN_KEY,
  COMMENT_META,
  readMappedRanges,
  decorationCommentId,
} from '../commentDecorations.js'
import type { CommentPluginState } from '../commentDecorations.js'
import {
  Y, createYContext, applyRemoteUpdate, seedUpdateFromPMJSON,
  Y_FRAGMENT, REMOTE_ORIGIN, encodeUpdateEnvelope, decodeUpdateEnvelope,
  checkFragmentRenderable, validateDocJSON,
} from '../../../lib/crdt/ydoc.js'
import type { YContext } from '../../../lib/crdt/ydoc.js'
import type { Comment } from '../../../lib/crdt/comments.js'

// Every case here mounts two REAL ProseMirror editors (full Docs extension set,
// tables included). That costs seconds in jsdom on a loaded machine, and it is
// the point — these tests must exercise the real view layer, not a mock of it.
// The default 5s per-test budget is too tight for that; nothing else is relaxed.
vi.setConfig({ testTimeout: 30_000 })

const extensions = () => [
  StarterKit.configure({ heading: { levels: [1, 2, 3, 4] }, history: false }),
  DocImage,
  Link.configure({ openOnClick: false }),
  TextStyle,
  Underline,
  Highlight.configure({ multicolor: true }),
  Table.configure({ resizable: true }),
  TableRow,
  TableCell,
  TableHeader,
  // Comments anchor into the document by position; they must survive remote edits.
  createCommentDecorationsExtension({ onActivate: () => {} }),
]

/** One collaborating client: a Y.Doc + a REAL TipTap editor bound to it. */
interface Peer {
  ydoc: Y.Doc
  ctx: YContext
  editor: Editor
  element: HTMLDivElement
  inbox: Uint8Array[]
}

function makePeer(): Peer {
  const ydoc = new Y.Doc()
  // No editor/schema exists yet — createYContext is seeded with a placeholder
  // and immediately corrected below once the editor (and its real schema) is
  // built. Nothing reads ctx.schema in between.
  const ctx = createYContext(null as unknown as Schema, ydoc)
  const element = document.createElement('div')
  document.body.appendChild(element)
  const editor = new Editor({
    element,
    extensions: [
      ...extensions(),
      YCollab.configure({ fragment: ydoc.getXmlFragment(Y_FRAGMENT) }),
    ],
  })
  ctx.schema = editor.schema
  return { ydoc, ctx, editor, element, inbox: [] }
}

/**
 * Connect peers on a manual "network". Every local update is delivered to the
 * others through applyRemoteUpdate — the SAME validated ingress the server and
 * p2p sessions use — so the tests exercise the real remote path.
 */
function connect(...peers: Peer[]) {
  for (const p of peers) {
    p.ydoc.on('update', (update, origin) => {
      if (origin === REMOTE_ORIGIN) return   // don't echo what we just received
      for (const q of peers) {
        if (q === p) continue
        q.inbox.push(update)                 // buffered: flush() decides delivery order
      }
    })
  }
  return {
    flush() {
      // Repeat until quiescent: an applied update can itself produce deliveries.
      for (let round = 0; round < 10; round++) {
        let moved = false
        for (const q of peers) {
          const pending = q.inbox
          q.inbox = []
          for (const u of pending) {
            const res = applyRemoteUpdate(q.ctx, u)
            expect(res.applied).toBe(true)
            moved = true
          }
        }
        if (!moved) return
      }
    },
  }
}

let peers: Peer[] = []
function peer(): Peer { const p = makePeer(); peers.push(p); return p }

beforeEach(() => { peers = [] })
afterEach(() => {
  for (const p of peers) { try { p.editor.destroy() } catch { /* already gone */ } p.element.remove() }
})

// Deep document comparison, deliberately NOT via getText().
const json = (p: Peer): JSONContent => p.editor.getJSON()

// ───────────────────────────────────────────────────────────────────────────
// 1. Formatting + structure propagate. (Under the old transport NONE of these
//    reached the peer: getText() carries no marks and no node types.)
// ───────────────────────────────────────────────────────────────────────────

describe('a remote peer sees formatting and structure, not just text', () => {
  it('propagates a BOLD mark', () => {
    const [a, b] = [peer(), peer()]
    const net = connect(a, b)

    a.editor.commands.setContent('<p>hello world</p>')
    net.flush()

    a.editor.commands.setTextSelection({ from: 1, to: 6 }) // "hello"
    a.editor.commands.toggleBold()
    net.flush()

    const para = json(b).content![0]
    const bolded = para.content!.find((n) => (n.marks || []).some((m) => m.type === 'bold'))
    expect(bolded).toBeTruthy()
    expect(bolded!.text).toBe('hello')
    // And the peers agree on the whole document, mark for mark.
    expect(json(b)).toEqual(json(a))
  })

  it('propagates a HEADING (a node-type change, invisible to a text diff)', () => {
    const [a, b] = [peer(), peer()]
    const net = connect(a, b)

    a.editor.commands.setContent('<p>Title</p>')
    net.flush()
    a.editor.commands.setTextSelection(2)
    a.editor.commands.toggleHeading({ level: 2 })
    net.flush()

    expect(json(b).content![0].type).toBe('heading')
    expect(json(b).content![0].attrs!.level).toBe(2)
    expect(json(b)).toEqual(json(a))
  })

  it('propagates a BULLET LIST', () => {
    const [a, b] = [peer(), peer()]
    const net = connect(a, b)

    a.editor.commands.setContent('<ul><li><p>one</p></li><li><p>two</p></li></ul>')
    net.flush()

    const list = json(b).content![0]
    expect(list.type).toBe('bulletList')
    expect(list.content).toHaveLength(2)
    expect(json(b)).toEqual(json(a))
  })

  it('propagates a TABLE with its cell structure intact', () => {
    const [a, b] = [peer(), peer()]
    const net = connect(a, b)

    a.editor.commands.setContent('<p>before</p>')
    net.flush()
    a.editor.commands.insertTable({ rows: 3, cols: 3, withHeaderRow: true })
    net.flush()

    const table = json(b).content!.find((n) => n.type === 'table')
    expect(table).toBeTruthy()
    expect(table!.content).toHaveLength(3)                       // 3 rows
    expect(table!.content![0].content).toHaveLength(3)            // 3 cells in row 1
    expect(table!.content![0].content![0].type).toBe('tableHeader')
    expect(json(b)).toEqual(json(a))
  })

  it('propagates an IMAGE node', () => {
    const [a, b] = [peer(), peer()]
    const net = connect(a, b)

    const src = 'data:image/png;base64,iVBORw0KGgo='
    a.editor.commands.setContent('<p>caption</p>')
    net.flush()
    a.editor.commands.setImage({ src, alt: 'a picture' })
    net.flush()

    const img = json(b).content!.flatMap((n) => n.content || []).find((n) => n.type === 'image')
      || json(b).content!.find((n) => n.type === 'image')
    expect(img).toBeTruthy()
    expect(img!.attrs!.src).toBe(src)
    expect(img!.attrs!.alt).toBe('a picture')
    expect(json(b)).toEqual(json(a))
  })

  it('propagates a LINK mark with its href', () => {
    const [a, b] = [peer(), peer()]
    const net = connect(a, b)

    a.editor.commands.setContent('<p>click here</p>')
    net.flush()
    a.editor.commands.setTextSelection({ from: 1, to: 6 })
    a.editor.commands.setLink({ href: 'https://vulos.org' })
    net.flush()

    const marked = json(b).content![0].content!.find((n) => (n.marks || []).some((m) => m.type === 'link'))
    expect(marked!.marks!.find((m) => m.type === 'link')!.attrs!.href).toBe('https://vulos.org')
    expect(json(b)).toEqual(json(a))
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 2. Concurrency: no edit may be placed at a wrong offset, and no edit may
//    corrupt the other's structure. This is the corruption class directly.
// ───────────────────────────────────────────────────────────────────────────

describe('concurrent edits converge without corrupting each other', () => {
  it('two peers editing different paragraphs converge to the same document', () => {
    const [a, b] = [peer(), peer()]
    const net = connect(a, b)

    a.editor.commands.setContent('<p>alpha</p><p>beta</p><p>gamma</p>')
    net.flush()

    // Concurrent (neither has seen the other) — insert at different offsets.
    a.editor.commands.insertContentAt(6, ' ONE')      // end of "alpha"
    b.editor.commands.insertContentAt(19, ' TWO')     // end of "gamma"
    net.flush()

    expect(json(a)).toEqual(json(b))
    const paras = json(a).content!.map((p) => (p.content || []).map((t) => t.text).join(''))
    expect(paras[0]).toBe('alpha ONE')
    expect(paras[2]).toBe('gamma TWO')
    expect(paras).toHaveLength(3)   // no paragraph was split or lost
  })

  it('a peer typing INSIDE a table cell does not shift or corrupt the other peer\'s structure', () => {
    const [a, b] = [peer(), peer()]
    const net = connect(a, b)

    a.editor.commands.setContent(
      '<p>intro</p>' +
      '<table><tbody>' +
      '<tr><th><p>h1</p></th><th><p>h2</p></th></tr>' +
      '<tr><td><p>r1c1</p></td><td><p>r1c2</p></td></tr>' +
      '</tbody></table>' +
      '<p>outro</p>',
    )
    net.flush()
    const before = json(b)

    // A writes inside the second data cell. Under the plain-text transport the
    // peer's offset landed in an entirely different node (getText() renders the
    // whole table as undelimited text) — cells were split and rows orphaned.
    const pos = findTextPos(a.editor, 'r1c2')
    a.editor.commands.insertContentAt(pos + 'r1c2'.length, '!')
    net.flush()

    const after = json(b)
    // Structure is byte-for-byte the same shape …
    expect(shape(after)).toEqual(shape(before))
    // … the edit landed in the RIGHT cell …
    const cellText = (doc: JSONContent, row: number, col: number): string | undefined =>
      doc.content!.find((n) => n.type === 'table')!.content![row].content![col].content![0].content![0].text
    expect(cellText(after, 1, 1)).toBe('r1c2!')
    // … and no other cell moved.
    expect(cellText(after, 1, 0)).toBe('r1c1')
    expect(cellText(after, 0, 0)).toBe('h1')
    expect(json(a)).toEqual(json(b))
  })

  it('a remote edit before a list does not corrupt the list items', () => {
    const [a, b] = [peer(), peer()]
    const net = connect(a, b)

    a.editor.commands.setContent('<p>lead</p><ul><li><p>one</p></li><li><p>two</p></li></ul>')
    net.flush()

    a.editor.commands.insertContentAt(1, 'XX')   // into the leading paragraph
    net.flush()

    const list = json(b).content!.find((n) => n.type === 'bulletList')
    expect(list!.content).toHaveLength(2)
    expect(list!.content![0].content![0].content![0].text).toBe('one')
    expect(list!.content![1].content![0].content![0].text).toBe('two')
    expect(json(a)).toEqual(json(b))
  })

  it('concurrent formatting and typing both survive the merge', () => {
    const [a, b] = [peer(), peer()]
    const net = connect(a, b)

    a.editor.commands.setContent('<p>shared sentence</p>')
    net.flush()

    a.editor.commands.setTextSelection({ from: 1, to: 7 })  // "shared"
    a.editor.commands.toggleBold()
    b.editor.commands.insertContentAt(16, ' more')          // end of the paragraph
    net.flush()

    expect(json(a)).toEqual(json(b))
    const text = json(a).content![0].content!.map((n) => n.text).join('')
    expect(text).toBe('shared sentence more')
    expect(json(a).content![0].content![0].marks!.some((m) => m.type === 'bold')).toBe(true)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 3. Round-trip: document → ops → document, compared on the document JSON.
// ───────────────────────────────────────────────────────────────────────────

describe('round-trip preserves the document exactly', () => {
  it('doc → Yjs update → doc is deep-equal (formatting, tables, images, links)', () => {
    const a = peer()
    a.editor.commands.setContent(
      '<h1>Report</h1>' +
      '<p><strong>bold</strong> and <em>italic</em> and <u>underline</u> and ' +
      '<a href="https://vulos.org">a link</a></p>' +
      '<ul><li><p>bullet</p></li></ul>' +
      '<table><tbody><tr><th><p>H</p></th></tr><tr><td><p>cell</p></td></tr></tbody></table>' +
      '<p><img src="data:image/png;base64,iVBORw0KGgo=" alt="pic"></p>',
    )
    const original = a.editor.getJSON()

    // Serialise the whole document as the transport would, and rebuild it.
    const update = seedUpdateFromPMJSON(a.editor.schema, original)
    const envelope = encodeUpdateEnvelope(update)
    const decoded = decodeUpdateEnvelope(envelope)
    expect(decoded).not.toBeNull()

    const rebuilt = new Y.Doc()
    Y.applyUpdate(rebuilt, decoded!)
    const res = checkFragmentRenderable(rebuilt.getXmlFragment(Y_FRAGMENT), a.editor.schema)
    expect(res.ok).toBe(true)
    expect(res.json).toEqual(original)
  })

  it('the seed is deterministic — two peers seeding the same content produce the same update', () => {
    const a = peer()
    a.editor.commands.setContent('<h2>Same</h2><p>content</p>')
    const doc = a.editor.getJSON()
    const u1 = seedUpdateFromPMJSON(a.editor.schema, doc)
    const u2 = seedUpdateFromPMJSON(a.editor.schema, doc)
    expect(Array.from(u1)).toEqual(Array.from(u2))

    // …and merging both (the concurrent-first-open race) yields ONE document,
    // not two copies of it.
    const merged = new Y.Doc()
    Y.applyUpdate(merged, u1)
    Y.applyUpdate(merged, u2)
    const res = checkFragmentRenderable(merged.getXmlFragment(Y_FRAGMENT), a.editor.schema)
    expect(res.json).toEqual(doc)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 4. Undo integrity: a peer's change must never enter the local undo history.
//    (Replaces the old undoRemote test, which pinned this for the plain-text
//    patch that no longer exists.)
// ───────────────────────────────────────────────────────────────────────────

describe('undo is user-scoped', () => {
  it("Ctrl+Z does not revert a REMOTE peer's change", () => {
    const [a, b] = [peer(), peer()]
    const net = connect(a, b)

    b.editor.commands.setContent('<p>hello</p>')
    net.flush()

    // Local edit by A, then a remote edit from B.
    a.editor.commands.insertContentAt(6, '!')       // "hello!"
    net.flush()
    b.editor.commands.insertContentAt(1, 'X')       // remote: "Xhello!"
    net.flush()

    const textOf = (p: Peer): string => p.editor.getJSON().content![0].content!.map((n) => n.text).join('')
    expect(textOf(a)).toBe('Xhello!')

    // A undoes. It must take back A's own "!" — never B's "X".
    a.editor.commands.undo()
    net.flush()
    expect(textOf(a)).toBe('Xhello')
    expect(textOf(b)).toBe('Xhello')
  })

  it('a remote change alone leaves this user nothing to undo', () => {
    const [a, b] = [peer(), peer()]
    const net = connect(a, b)

    b.editor.commands.setContent('<p>abc</p>')
    b.editor.commands.insertContentAt(4, 'd')     // purely remote, from A's view
    net.flush()

    expect(a.editor.getJSON().content![0].content![0].text).toBe('abcd')
    expect(a.editor.can().undo()).toBe(false)     // not on A's undo stack
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 5. Hostile peer: untrusted content is refused, fail-closed. A peer inside the
//    room is NOT trusted (an invite link may have been forwarded to anyone).
// ───────────────────────────────────────────────────────────────────────────

describe('a hostile peer cannot inject content or crash the renderer', () => {
  it('drops garbage bytes without throwing and leaves the document untouched', () => {
    const a = peer()
    a.editor.commands.setContent('<p>safe</p>')
    const before = json(a)

    const res = applyRemoteUpdate(a.ctx, new Uint8Array([1, 2, 3, 250, 99, 7]))
    expect(res.applied).toBe(false)
    expect(json(a)).toEqual(before)
  })

  it('refuses an update whose document the schema cannot render (unknown node type)', () => {
    const a = peer()
    a.editor.commands.setContent('<p>safe</p>')
    const before = json(a)

    // Craft the update in a Y.Doc with no schema policing it — exactly what a
    // hostile peer would put on the wire.
    const evil = new Y.Doc()
    const frag = evil.getXmlFragment(Y_FRAGMENT)
    const el = new Y.XmlElement('totallyBogusNode')
    el.insert(0, [new Y.XmlText('boom')])
    frag.insert(0, [el])

    const res = applyRemoteUpdate(a.ctx, Y.encodeStateAsUpdate(evil))
    expect(res.applied).toBe(false)
    expect(res.reason).toBeTruthy()
    // The live document is untouched and the editor is still alive.
    expect(json(a)).toEqual(before)
    a.editor.commands.insertContentAt(1, 'ok')
    expect(json(a).content![0].content![0].text).toContain('ok')
  })

  it('refuses a javascript: link and an SVG image src (sanitisation cannot be bypassed by a peer)', () => {
    const a = peer()

    expect(validateDocJSON({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }],
      }],
    })).toMatch(/unsafe link/i)

    expect(validateDocJSON({
      type: 'doc',
      content: [{ type: 'image', attrs: { src: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' } }],
    })).toMatch(/image src/i)

    // A clean document passes.
    a.editor.commands.setContent('<p><a href="https://vulos.org">ok</a></p>')
    expect(validateDocJSON(a.editor.getJSON())).toBeNull()
  })

  it('refuses an oversized update at the envelope boundary', () => {
    const huge = { y: 1, u: 'A'.repeat(4_000_000) }
    expect(decodeUpdateEnvelope(huge)).toBeNull()
    expect(decodeUpdateEnvelope({ y: 1, u: 'not base64!!' })).toBeNull()
    expect(decodeUpdateEnvelope({ y: 2, u: 'AAAA' })).toBeNull()   // unknown version
    expect(decodeUpdateEnvelope(null)).toBeNull()
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 6. Comments anchor into the document by ProseMirror position. A remote peer's
//    edit must move those anchors with the text, not leave them pointing at the
//    wrong words. (This is the feature the old transport quietly endangered: it
//    applied remote changes at text offsets, so an anchor could end up over
//    completely different content.)
// ───────────────────────────────────────────────────────────────────────────

describe('comment anchors survive a remote peer\'s edit', () => {
  it('an anchor shifts with its text when a peer inserts BEFORE it', () => {
    const [a, b] = [peer(), peer()]
    const net = connect(a, b)

    b.editor.commands.setContent('<p>hello brave world</p>')
    net.flush()

    // Anchor a comment on "world" in B's editor.
    const from = findTextPos(b.editor, 'world')
    const to = from + 'world'.length
    const comments = [{ id: 'c1', anchor: { type: 'text_range', from, to }, resolved: false }]
    dispatchComments(b.editor, comments)
    expect(anchoredText(b.editor, 'c1')).toBe('world')

    // A remote peer inserts text BEFORE the anchor. Every position after the
    // insertion moves; the anchor must move with it.
    a.editor.commands.insertContentAt(1, 'oh, ')
    net.flush()

    const mapped = readMappedRanges(
      commentPluginState(b.editor).decorations,
      asComments(comments),
    )
    const range = mapped.get('c1')
    expect(range).toBeTruthy()
    expect(range!.from).toBe(from + 'oh, '.length)
    // And it still covers exactly the words it was attached to.
    expect(anchoredText(b.editor, 'c1')).toBe('world')
  })

  it('an anchor inside a table cell stays in that cell when a peer edits another cell', () => {
    const [a, b] = [peer(), peer()]
    const net = connect(a, b)

    b.editor.commands.setContent(
      '<table><tbody><tr><td><p>left</p></td><td><p>right</p></td></tr></tbody></table>',
    )
    net.flush()

    const from = findTextPos(b.editor, 'right')
    const comments = [{
      id: 'c2',
      anchor: { type: 'text_range', from, to: from + 'right'.length },
      resolved: false,
    }]
    dispatchComments(b.editor, comments)

    // A edits the OTHER cell.
    const otherPos = findTextPos(a.editor, 'left')
    a.editor.commands.insertContentAt(otherPos + 'left'.length, ' side')
    net.flush()

    expect(anchoredText(b.editor, 'c2')).toBe('right')
  })
})

// ── helpers ────────────────────────────────────────────────────────────────

// The comment shape these tests build is a minimal stand-in for the full CRDT
// `Comment` record (only `id`/`anchor` are read by the code under test here) —
// cast through a narrow local type rather than `any`.
interface AnchorTestComment {
  id: string
  anchor: { type: string; from: number; to: number }
  resolved: boolean
}
function asComments(cs: AnchorTestComment[]): Comment[] {
  return cs as unknown as Comment[]
}

/** The comment-decorations plugin's live state — throws if the extension
 *  somehow isn't active (it always is in these tests; this just satisfies the
 *  PluginKey.getState() → possibly-undefined return type). */
function commentPluginState(editor: Editor): CommentPluginState {
  const state = COMMENT_PLUGIN_KEY.getState(editor.state)
  if (!state) throw new Error('comment decorations plugin not active')
  return state
}

/** Push a comment list into the decoration plugin (as DocsEditor does). */
function dispatchComments(editor: Editor, comments: AnchorTestComment[]): void {
  const tr = editor.state.tr
  tr.setMeta(COMMENT_META, { comments: asComments(comments), activeId: null })
  editor.view.dispatch(tr)
}

/** The document text currently covered by a comment's (mapped) anchor. */
function anchoredText(editor: Editor, commentId: string): string | null {
  const decos = commentPluginState(editor).decorations.find()
  const d = decos.find((x) => decorationCommentId(x) === commentId)
  if (!d) return null
  return editor.state.doc.textBetween(d.from, d.to, ' ')
}

/** Document position of the first occurrence of `needle`. */
function findTextPos(editor: Editor, needle: string): number {
  let found = -1
  editor.state.doc.descendants((node, pos) => {
    if (found >= 0) return false
    if (node.isText && node.text && node.text.includes(needle)) found = pos + node.text.indexOf(needle)
    return true
  })
  if (found < 0) throw new Error(`text not found: ${needle}`)
  return found
}

/** The document's structure with all text stripped — for "did the shape move?" */
function shape(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(shape)
  if (!node || typeof node !== 'object') return node
  const n = node as JSONContent
  const out: Record<string, unknown> = { type: n.type }
  if (n.attrs) out.attrs = n.attrs
  if (n.content) out.content = n.content.map(shape)
  if (n.text != null) out.type = 'text'
  return out
}
