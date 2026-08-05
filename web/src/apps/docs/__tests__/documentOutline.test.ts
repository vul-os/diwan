/**
 * Tests for the Document Outline navigation logic:
 *   - extractOutline pulls headings (level/text/pos) in document order
 *   - computeActiveHeadingIndex resolves the in-view section deterministically
 */

import { describe, it, expect } from 'vitest'
import type { Editor } from '@tiptap/react'
import { extractOutline, computeActiveHeadingIndex } from '../components/DocumentOutline.js'

interface FakeOutlineNode {
  type: string
  attrs?: Record<string, unknown>
  text?: string
}

// Shape extractOutline actually reads off `editor.state.doc.descendants(fn)` —
// not a real ProseMirror node/doc, so this is a local stand-in cast through a
// narrow type rather than a real Editor instance.
interface FakePMNode {
  type: { name: string }
  attrs: Record<string, unknown>
  textContent: string
}
type DescendantsFn = (node: FakePMNode, pos: number) => void
interface FakeEditor {
  state: { doc: { descendants: (fn: DescendantsFn) => void } }
}

// Build a fake ProseMirror doc whose `descendants(fn)` walks a flat node list,
// invoking fn(node, pos) — matching the shape extractOutline relies on.
function makeEditor(nodes: FakeOutlineNode[]): Editor {
  const fake: FakeEditor = {
    state: {
      doc: {
        descendants(fn) {
          let pos = 0
          for (const n of nodes) {
            fn(
              { type: { name: n.type }, attrs: n.attrs || {}, textContent: n.text || '' },
              pos,
            )
            pos += (n.text?.length || 0) + 2
          }
        },
      },
    },
  }
  return fake as unknown as Editor
}

describe('extractOutline', () => {
  it('collects only headings, in order, with level + text + pos', () => {
    const editor = makeEditor([
      { type: 'heading', attrs: { level: 1 }, text: 'Title' },
      { type: 'paragraph', text: 'body text here' },
      { type: 'heading', attrs: { level: 2 }, text: 'Section A' },
      { type: 'heading', attrs: { level: 3 }, text: 'Sub A.1' },
    ])
    const out = extractOutline(editor)
    expect(out).toHaveLength(3)
    expect(out.map((h) => h.text)).toEqual(['Title', 'Section A', 'Sub A.1'])
    expect(out.map((h) => h.level)).toEqual([1, 2, 3])
    expect(out.every((h) => typeof h.pos === 'number')).toBe(true)
    // Positions must be strictly increasing (document order).
    expect(out[0].pos).toBeLessThan(out[1].pos)
    expect(out[1].pos).toBeLessThan(out[2].pos)
  })

  it('returns an empty array for a doc with no headings', () => {
    expect(extractOutline(makeEditor([{ type: 'paragraph', text: 'hi' }]))).toEqual([])
  })

  it('is null-safe', () => {
    expect(extractOutline(null)).toEqual([])
    expect(extractOutline({} as unknown as Editor)).toEqual([])
  })

  it('defaults missing heading level to 1', () => {
    const out = extractOutline(makeEditor([{ type: 'heading', text: 'No level' }]))
    expect(out[0].level).toBe(1)
  })
})

describe('computeActiveHeadingIndex', () => {
  const tops = [0, 300, 600, 900]

  it('selects the first heading at the top of the document', () => {
    expect(computeActiveHeadingIndex(tops, 0)).toBe(0)
  })

  it('selects the section whose heading is at or above the reading line', () => {
    expect(computeActiveHeadingIndex(tops, 310)).toBe(1)
    expect(computeActiveHeadingIndex(tops, 650)).toBe(2)
    expect(computeActiveHeadingIndex(tops, 5000)).toBe(3)
  })

  it('applies the threshold so a heading just below the top still activates', () => {
    // heading at 300, scrollTop 280, threshold 24 → line 304 >= 300 → active 1
    expect(computeActiveHeadingIndex(tops, 280, 24)).toBe(1)
    // scrollTop 270 → line 294 < 300 → still on heading 0
    expect(computeActiveHeadingIndex(tops, 270, 24)).toBe(0)
  })

  it('returns -1 for an empty outline', () => {
    expect(computeActiveHeadingIndex([], 0)).toBe(-1)
    expect(computeActiveHeadingIndex(null as unknown as number[], 0)).toBe(-1)
  })
})
