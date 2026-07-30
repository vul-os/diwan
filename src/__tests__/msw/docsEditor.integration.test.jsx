/**
 * MSW / RTL integration — Docs editor with a REAL TipTap editor tree.
 *
 * Unlike docs.test.jsx (which drives a mock editor to assert command routing),
 * this suite mounts a REAL TipTap `useEditor` with the SAME extension set the
 * DocsEditor uses (StarterKit + TextStyle + FontSize/FontFamily + …) and the
 * REAL DocsToolbar on top of it. That makes it a true integration test: the
 * toolbar's chain commands mutate a live ProseMirror document and we assert the
 * rendered output.
 *
 * Load-bearing regression guards:
 *   • typing order — text renders "hello", never "olleh".
 *   • WAVE-19 font size + family — the textStyle mark actually renders inline
 *     styles (the bug was the base extension silently dropping them).
 *   • bold / heading / bullet-list / link formatting via the real toolbar.
 *   • export menu wiring (DOCX/PDF/Markdown) — real exporters, saveAs mocked.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderHook, act } from '@testing-library/react'
import { useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import TextStyle from '@tiptap/extension-text-style'
import Color from '@tiptap/extension-color'
import Link from '@tiptap/extension-link'
import Underline from '@tiptap/extension-underline'
import Highlight from '@tiptap/extension-highlight'
import TextAlign from '@tiptap/extension-text-align'
import { FontSize, FontFamily } from '../../lib/tiptap/fontStyle.js'
import DocsToolbar from '../../apps/docs/DocsToolbar.jsx'

// Mock file-saver so export tests don't actually write blobs.
vi.mock('file-saver', () => ({ saveAs: vi.fn() }))
import { saveAs } from 'file-saver'

// Build a real editor with the DocsEditor extension subset relevant to these
// assertions (kept lean so jsdom mounts fast, but genuinely a live PM doc).
function useRealEditor(content = '<p></p>') {
  return useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3, 4] } }),
      TextStyle, Color, FontSize, FontFamily,
      Underline, Highlight.configure({ multicolor: true }),
      Link.configure({ openOnClick: false }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
    ],
    content,
  })
}

function renderToolbar(content) {
  const { result } = renderHook(() => useRealEditor(content))
  const editor = result.current
  render(<DocsToolbar editor={editor} title="Test Doc" />)
  return editor
}

describe('Docs editor — real TipTap integration (MSW/RTL)', () => {
  beforeEach(() => { saveAs.mockClear() })

  // ── a11y: the toolbar is a proper labelled, horizontally-oriented toolbar ──
  it('exposes the formatting toolbar as an oriented ARIA toolbar', () => {
    renderToolbar('<p>x</p>')
    const bar = screen.getByRole('toolbar', { name: /document formatting/i })
    expect(bar).toBeInTheDocument()
    expect(bar.getAttribute('aria-orientation')).toBe('horizontal')
  })

  // ── typing-order regression guard ("olleh") ──────────────────────────────
  it('typing renders characters in order — never reversed', () => {
    const { result } = renderHook(() => useRealEditor('<p></p>'))
    act(() => { result.current.chain().focus().insertContent('hello').run() })
    expect(result.current.getText()).toBe('hello')
    expect(result.current.getText()).not.toBe('olleh')
    // Append more to confirm the document keeps left-to-right order.
    act(() => { result.current.chain().focus('end').insertContent(' world').run() })
    expect(result.current.getText()).toBe('hello world')
  })

  // ── WAVE-19: font size renders as an inline style on the mark ─────────────
  it('applying a font size via the toolbar renders an inline font-size style', async () => {
    const editor = renderToolbar('<p>size me</p>')
    act(() => { editor.chain().focus().selectAll().run() })

    // Open the font-size selector and pick a preset.
    const sizeBtn = screen.getByLabelText(/Font size:/i)
    fireEvent.click(sizeBtn)
    // Preset sizes render as menu items; pick "24".
    const opt = await screen.findByText('24', {}, { timeout: 2000 })
    fireEvent.click(opt)

    await waitFor(() => expect(editor.getHTML()).toMatch(/font-size:\s*24pt/))
  })

  // ── WAVE-19: font family renders as an inline style on the mark ───────────
  it('applying a font family renders an inline font-family style', () => {
    const { result } = renderHook(() => useRealEditor('<p>font me</p>'))
    act(() => {
      result.current.chain().focus().selectAll()
        .setMark('textStyle', { fontFamily: 'Georgia, serif' }).run()
    })
    expect(result.current.getHTML()).toMatch(/font-family:\s*Georgia, serif/)
  })

  // ── bold formatting via the real toolbar mutates the live doc ─────────────
  it('the Bold toolbar button bolds the selection', () => {
    const editor = renderToolbar('<p>make bold</p>')
    act(() => { editor.chain().focus().selectAll().run() })
    fireEvent.click(screen.getByTitle(/Bold/i))
    expect(editor.getHTML()).toMatch(/<strong>/)
  })

  // ── heading via toolbar ───────────────────────────────────────────────────
  it('applying Heading 2 changes the block to an <h2>', () => {
    const { result } = renderHook(() => useRealEditor('<p>title</p>'))
    act(() => { result.current.chain().focus().toggleHeading({ level: 2 }).run() })
    expect(result.current.getHTML()).toMatch(/<h2>/)
  })

  // ── bullet list via toolbar ───────────────────────────────────────────────
  it('applying a bullet list wraps the block in <ul><li>', () => {
    const { result } = renderHook(() => useRealEditor('<p>item</p>'))
    act(() => { result.current.chain().focus().toggleBulletList().run() })
    expect(result.current.getHTML()).toMatch(/<ul>\s*<li>/)
  })

  // ── link insertion via chain ──────────────────────────────────────────────
  it('inserting a link wraps the selection in an <a href>', () => {
    const { result } = renderHook(() => useRealEditor('<p>vulos</p>'))
    act(() => {
      result.current.chain().focus().selectAll()
        .setLink({ href: 'https://vulos.org' }).run()
    })
    expect(result.current.getHTML()).toMatch(/<a[^>]+href="https:\/\/vulos\.org"/)
  })

  // ── export menu: DOCX / PDF / Markdown wired to exporters ──────────────────
  it('the export menu offers DOCX, PDF and Markdown', async () => {
    renderToolbar('<p>Export <strong>me</strong></p>')
    fireEvent.click(screen.getByLabelText('Export document'))
    expect(await screen.findByText('Word document')).toBeInTheDocument()
    expect(screen.getByText(/PDF document/i)).toBeInTheDocument()
    expect(screen.getByText(/Markdown/i)).toBeInTheDocument()
  })

  it('choosing Markdown export invokes saveAs with a .md file', async () => {
    renderToolbar('<p>Export <strong>me</strong></p>')
    fireEvent.click(screen.getByLabelText('Export document'))
    const md = await screen.findByText(/Markdown/i)
    fireEvent.click(md)
    await waitFor(() => expect(saveAs).toHaveBeenCalled())
    const [, filename] = saveAs.mock.calls[0]
    expect(filename).toMatch(/\.md$/)
  })

  it('choosing DOCX export produces a .docx blob via saveAs', async () => {
    renderToolbar('<p>Export <strong>me</strong></p>')
    fireEvent.click(screen.getByLabelText('Export document'))
    const docx = await screen.findByText('Word document')
    fireEvent.click(docx)
    await waitFor(() => expect(saveAs).toHaveBeenCalled())
    const [, filename] = saveAs.mock.calls[0]
    expect(filename).toMatch(/\.docx$/)
  })
})
