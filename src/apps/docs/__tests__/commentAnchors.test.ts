/**
 * WAVE-45 — unit tests for comment-anchor highlighting + click-to-jump helpers
 * and footnote numbering. These test the pure logic (anchor clamping/remap,
 * mapped-range readback, footnote order/reconcile) without a live ProseMirror
 * editor, which is where the correctness risk actually lives.
 */

import { describe, it, expect } from 'vitest'
import type { Decoration, DecorationSet, DecorationAttrs } from '@tiptap/pm/view'
import {
  clampAnchor,
  buildDecorationSpecs,
  readMappedRanges,
  decorationCommentId,
} from '../commentDecorations.js'
import {
  computeFootnoteOrder,
  reconcileFootnoteItems,
  nextFootnoteId,
} from '../footnotes.js'
import type { Comment } from '../../../lib/crdt/comments.js'

// These tests exercise the pure decoration/comment helpers with hand-built
// stand-ins rather than a live pm-view Decoration/DecorationSet or a full
// Comment record — only the fields each helper actually reads. Cast through
// a narrow local type, same pattern the production module itself uses for
// Decoration's untyped `.spec`/`.type` (see commentDecorations.ts's own
// `DecorationLike`).
type CommentStub = Pick<Comment, 'id' | 'state' | 'anchor'>
const asComment = (c: CommentStub): Comment => c as unknown as Comment

type DecorationStub = {
  from?: number
  to?: number
  type?: { attrs?: DecorationAttrs }
  spec?: { attrs?: DecorationAttrs }
}
const asDeco = (d: DecorationStub): Decoration => d as unknown as Decoration

// ─── clampAnchor ──────────────────────────────────────────────────────────────

describe('clampAnchor', () => {
  const DOC = 100

  it('returns the range for a valid text anchor', () => {
    expect(clampAnchor({ type: 'text_range', from: 5, to: 12 }, DOC)).toEqual({ from: 5, to: 12 })
  })

  it('clamps a range that overshoots the document size', () => {
    expect(clampAnchor({ type: 'text_range', from: 90, to: 200 }, DOC)).toEqual({ from: 90, to: 100 })
  })

  it('returns null for an orphaned anchor', () => {
    expect(clampAnchor({ type: 'text_range', from: 5, to: 12, orphaned: true }, DOC)).toBeNull()
  })

  it('returns null for a non-text anchor (slide/cell)', () => {
    expect(clampAnchor({ type: 'slide', slide_id: 'x' }, DOC)).toBeNull()
    expect(clampAnchor({ type: 'cell', row: 1, col: 1 }, DOC)).toBeNull()
  })

  it('returns null when the range collapses to zero width', () => {
    expect(clampAnchor({ type: 'text_range', from: 10, to: 10 }, DOC)).toBeNull()
    // Both beyond doc → clamp both to 100 → collapsed → null (text was deleted).
    expect(clampAnchor({ type: 'text_range', from: 150, to: 160 }, DOC)).toBeNull()
  })

  it('swaps inverted from/to defensively', () => {
    expect(clampAnchor({ type: 'text_range', from: 12, to: 5 }, DOC)).toEqual({ from: 5, to: 12 })
  })

  it('returns null for missing/garbage input', () => {
    expect(clampAnchor(null, DOC)).toBeNull()
    expect(clampAnchor({ type: 'text_range' }, DOC)).toBeNull()
  })
})

// ─── buildDecorationSpecs ─────────────────────────────────────────────────────

describe('buildDecorationSpecs', () => {
  it('produces one spec per live anchor and flags resolved state', () => {
    const comments = [
      asComment({ id: 'a', state: 'open', anchor: { type: 'text_range', from: 2, to: 6 } }),
      asComment({ id: 'b', state: 'resolved', anchor: { type: 'text_range', from: 8, to: 10 } }),
    ]
    const { specs, orphans } = buildDecorationSpecs(comments, 50)
    expect(specs).toHaveLength(2)
    expect(specs[0]).toMatchObject({ commentId: 'a', from: 2, to: 6, resolved: false })
    expect(specs[1]).toMatchObject({ commentId: 'b', resolved: true })
    expect(orphans).toHaveLength(0)
  })

  it('reports text anchors that collapsed as orphans, skips non-text anchors', () => {
    const comments = [
      asComment({ id: 'gone', state: 'open', anchor: { type: 'text_range', from: 200, to: 210 } }),
      asComment({ id: 'slide', state: 'open', anchor: { type: 'slide', slide_id: 's1' } }),
      asComment({ id: 'ok', state: 'open', anchor: { type: 'text_range', from: 3, to: 9 } }),
    ]
    const { specs, orphans } = buildDecorationSpecs(comments, 50)
    expect(specs.map((s) => s.commentId)).toEqual(['ok'])
    expect(orphans).toEqual(['gone'])
  })

  it('handles an empty / undefined comment list without throwing', () => {
    expect(buildDecorationSpecs(undefined, 50)).toEqual({ specs: [], orphans: [] })
    expect(buildDecorationSpecs([], 50)).toEqual({ specs: [], orphans: [] })
  })
})

// ─── readMappedRanges (simulated DecorationSet) ───────────────────────────────

// Minimal stand-in for a ProseMirror DecorationSet: only needs `.find()`.
// Inline decorations expose their DOM attrs at `type.attrs` (verified against a
// live pm-view instance), which is where decorationCommentId reads from.
function fakeDecorationSet(decos: Decoration[]): DecorationSet {
  return { find: () => decos } as unknown as DecorationSet
}
function fakeDeco(commentId: string, from: number, to: number): Decoration {
  return asDeco({ from, to, type: { attrs: { 'data-comment-id': commentId } }, spec: {} })
}

describe('decorationCommentId', () => {
  it('reads the id from type.attrs (inline decoration layout)', () => {
    expect(decorationCommentId(fakeDeco('c1', 1, 5))).toBe('c1')
  })
  it('falls back to spec.attrs', () => {
    expect(decorationCommentId(asDeco({ spec: { attrs: { 'data-comment-id': 'c2' } } }))).toBe('c2')
  })
  it('returns null when no id is present', () => {
    expect(decorationCommentId(asDeco({}))).toBeNull()
    expect(decorationCommentId(null)).toBeNull()
  })
})

describe('readMappedRanges', () => {
  it('reports the live range for each comment still present in the body', () => {
    const decos = fakeDecorationSet([
      fakeDeco('a', 4, 9),
      fakeDeco('b', 12, 20),
    ])
    const comments = [
      asComment({ id: 'a', state: 'open', anchor: { type: 'text_range' } }),
      asComment({ id: 'b', state: 'open', anchor: { type: 'text_range' } }),
    ]
    const map = readMappedRanges(decos, comments)
    expect(map.get('a')).toEqual({ from: 4, to: 9 })
    expect(map.get('b')).toEqual({ from: 12, to: 20 })
  })

  it('reports null (orphan) for a comment whose decoration vanished', () => {
    const decos = fakeDecorationSet([fakeDeco('a', 4, 9)])
    const comments = [
      asComment({ id: 'a', state: 'open', anchor: { type: 'text_range' } }),
      asComment({ id: 'b', state: 'open', anchor: { type: 'text_range' } }), // no decoration → orphaned
    ]
    const map = readMappedRanges(decos, comments)
    expect(map.get('a')).toEqual({ from: 4, to: 9 })
    expect(map.get('b')).toBeNull()
  })

  it('prefers the widest span when a comment has duplicate decorations (base + flash)', () => {
    const decos = fakeDecorationSet([
      fakeDeco('a', 4, 9),
      fakeDeco('a', 4, 9), // flash duplicate — same span
    ])
    const comments = [asComment({ id: 'a', state: 'open', anchor: { type: 'text_range' } })]
    const map = readMappedRanges(decos, comments)
    expect(map.get('a')).toEqual({ from: 4, to: 9 })
  })

  it('ignores non-text anchors', () => {
    const decos = fakeDecorationSet([])
    const comments = [asComment({ id: 's', state: 'open', anchor: { type: 'slide' } })]
    const map = readMappedRanges(decos, comments)
    expect(map.has('s')).toBe(false)
  })
})

// ─── footnote numbering ───────────────────────────────────────────────────────

describe('computeFootnoteOrder', () => {
  it('numbers refs 1..N in body order', () => {
    const order = computeFootnoteOrder(['x', 'y', 'z'])
    expect(order.get('x')).toBe(1)
    expect(order.get('y')).toBe(2)
    expect(order.get('z')).toBe(3)
  })

  it('renumbers automatically when a footnote is inserted in the middle', () => {
    // Author inserts "mid" between x and z.
    const before = computeFootnoteOrder(['x', 'z'])
    const after = computeFootnoteOrder(['x', 'mid', 'z'])
    expect(before.get('z')).toBe(2)
    expect(after.get('mid')).toBe(2)
    expect(after.get('z')).toBe(3) // pushed down
  })

  it('a duplicated id keeps its first-seen number', () => {
    const order = computeFootnoteOrder(['x', 'y', 'x'])
    expect(order.get('x')).toBe(1)
    expect(order.get('y')).toBe(2)
    expect(order.size).toBe(2)
  })

  it('handles an empty list', () => {
    expect(computeFootnoteOrder([]).size).toBe(0)
  })
})

describe('reconcileFootnoteItems', () => {
  it('finds refs needing a new list entry', () => {
    const { toAdd, toRemove, ordered } = reconcileFootnoteItems(['a', 'b', 'c'], ['a'])
    expect(toAdd).toEqual(['b', 'c'])
    expect(toRemove).toEqual([])
    expect(ordered).toEqual(['a', 'b', 'c'])
  })

  it('finds orphaned list items whose ref was deleted from the body', () => {
    const { toAdd, toRemove } = reconcileFootnoteItems(['a'], ['a', 'b', 'c'])
    expect(toAdd).toEqual([])
    expect(toRemove).toEqual(['b', 'c'])
  })

  it('preserves body order in `ordered` and de-dupes', () => {
    const { ordered } = reconcileFootnoteItems(['b', 'a', 'b'], ['a', 'b'])
    expect(ordered).toEqual(['b', 'a'])
  })
})

describe('nextFootnoteId', () => {
  it('generates unique, prefixed ids', () => {
    const a = nextFootnoteId()
    const b = nextFootnoteId()
    expect(a).toMatch(/^fn-/)
    expect(b).toMatch(/^fn-/)
    expect(a).not.toBe(b)
  })
})
