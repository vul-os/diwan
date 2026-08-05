/**
 * P5 — Live-updating table of contents.
 *
 * Coverage:
 *   1. readHeadings derives the outline from a doc (level + text + slug).
 *   2. The live ToC node inserts as an atomic block and re-reads headings when a
 *      heading changes (the outline updates without a manual "Update").
 *   3. Export bakes the current outline into the ToC shell.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import Heading from '@tiptap/extension-heading'

import { TableOfContentsNode, readHeadings } from '../tableOfContents.js'
import { exportToHtml } from '../docsExport.js'
import { saveAs } from 'file-saver'

vi.mock('file-saver', () => ({ saveAs: vi.fn() }))

function makeEditor(content: string): Editor {
  return new Editor({
    extensions: [Document, Paragraph, Text, Heading.configure({ levels: [1, 2, 3] }), TableOfContentsNode],
    content,
  })
}

let editor: Editor | null = null
afterEach(() => { editor?.destroy(); editor = null; vi.clearAllMocks() })

// A saveAs Blob argument narrowed away from the `Blob | string` union the real
// file-saver signature allows — this suite only ever hands it a Blob.
function savedBlob(): Blob {
  const data = vi.mocked(saveAs).mock.calls[0][0]
  if (!(data instanceof Blob)) throw new Error('expected saveAs to be called with a Blob')
  return data
}

describe('readHeadings', () => {
  it('reads the outline with level, text, slug', () => {
    editor = makeEditor('<h1>Intro</h1><p>x</p><h2>Details Here</h2>')
    const hs = readHeadings(editor.state.doc)
    expect(hs).toHaveLength(2)
    expect(hs[0]).toMatchObject({ level: 1, text: 'Intro', slug: 'intro' })
    expect(hs[1]).toMatchObject({ level: 2, text: 'Details Here', slug: 'details-here' })
  })
})

describe('live ToC node', () => {
  it('inserts as an atomic block', () => {
    editor = makeEditor('<h1>A</h1>')
    editor.commands.insertTableOfContents()
    expect(JSON.stringify(editor.getJSON())).toContain('"tableOfContents"')
  })

  it('outline reflects heading edits (live, not stale)', () => {
    editor = makeEditor('<h1>First</h1><p></p>')
    // Put the caret in the trailing paragraph, then insert the ToC there so we
    // don't split the heading.
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    editor.commands.insertTableOfContents()
    expect(readHeadings(editor.state.doc).map((h) => h.text)).toEqual(['First'])

    // Add a heading → the outline (a live projection) reflects it immediately.
    editor.commands.insertContentAt(0, '<h2>Zero</h2>')
    const texts = readHeadings(editor.state.doc).map((h) => h.text)
    expect(texts).toContain('Zero')
    expect(texts).toContain('First')
  })

  it('serialises to a data-toc shell', () => {
    editor = makeEditor('<h1>A</h1>')
    editor.commands.insertTableOfContents()
    expect(editor.getHTML()).toContain('data-toc')
  })
})

describe('ToC export', () => {
  it('bakes the current outline into the exported ToC', async () => {
    editor = makeEditor('<h1>Alpha</h1><h2>Beta</h2>')
    editor.commands.insertTableOfContents()
    exportToHtml(editor, 'doc', {})
    const blob = savedBlob()
    const text = await blob.text()
    expect(text).toContain('Table of Contents')
    expect(text).toContain('Alpha')
    expect(text).toContain('Beta')
    expect(text).toContain('href="#alpha"')
  })
})
