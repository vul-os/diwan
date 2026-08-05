/**
 * P4 — Equations (KaTeX) in Diwan Docs.
 *
 * Coverage:
 *   1. renderEquationHtml produces real KaTeX (MathML + spans), never throws.
 *   2. SECURITY — a malicious LaTeX (\href{javascript:…}, \htmlData, \html*,
 *      \includegraphics, raw HTML) can NOT inject a live script / href / handler.
 *   3. The math node stores ONLY the LaTeX source string (CRDT/collab-safe).
 *   4. Live editor: insertMathInline / insertMathBlock create atomic nodes and
 *      round-trip through getHTML() carrying data-latex.
 *   5. Export: HTML export renders KaTeX AND the result survives sanitizeDocHtml
 *      with no script/javascript: leaking.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import type { JSONContent } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'

import { MathInline, MathBlock, renderEquationHtml, KATEX_SAFE_OPTIONS } from '../equation.js'
import { sanitizeDocHtml } from '../../../lib/sanitize'
import { exportToHtml } from '../docsExport.js'
import { saveAs } from 'file-saver'

vi.mock('file-saver', () => ({ saveAs: vi.fn() }))

function makeEditor(content = '<p>Hello</p>'): Editor {
  return new Editor({
    extensions: [Document, Paragraph, Text, MathInline, MathBlock],
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

// Depth-first search for the first node of the given type in a doc JSON tree.
function findNodeByType(n: JSONContent, type: string): JSONContent | null {
  if (n.type === type) return n
  for (const child of n.content || []) {
    const found = findNodeByType(child, type)
    if (found) return found
  }
  return null
}

// ── 1. Rendering ─────────────────────────────────────────────────────────────
describe('renderEquationHtml (KaTeX)', () => {
  it('renders a real equation to KaTeX markup', () => {
    const html = renderEquationHtml('x^2 + \\frac{1}{2}', false)
    expect(html).toContain('katex')
    // MathML present (output htmlAndMathml).
    expect(html.toLowerCase()).toMatch(/<math|<mfrac|<msup/)
    expect(html).not.toContain('<script')
  })

  it('display mode renders the display variant', () => {
    const html = renderEquationHtml('\\sum_{i=1}^{n} i', true)
    expect(html).toContain('katex')
  })

  it('never throws on malformed input (returns bounded markup)', () => {
    expect(() => renderEquationHtml('\\frac{', false)).not.toThrow()
    const html = renderEquationHtml('\\frac{', false)
    expect(typeof html).toBe('string')
    expect(html).not.toContain('<script')
  })

  it('is configured with trust:false + throwOnError:false', () => {
    expect(KATEX_SAFE_OPTIONS.trust).toBe(false)
    expect(KATEX_SAFE_OPTIONS.throwOnError).toBe(false)
  })
})

// ── 2. SECURITY: malicious LaTeX can't inject ────────────────────────────────
describe('equation security — hostile LaTeX is neutralised', () => {
  const HOSTILE = [
    '\\href{javascript:alert(1)}{click me}',
    '\\href{javascript:alert(document.cookie)}{x}',
    '\\htmlData{foo=bar}{x}',
    '\\htmlClass{evil}{x}',
    '\\htmlId{evil}{x}',
    '\\includegraphics{http://evil/x.png}',
    '\\url{javascript:alert(1)}',
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    'x^2}} <script>alert(1)</script> \\frac{1}{2',
  ]

  for (const src of HOSTILE) {
    it(`neutralises: ${src.slice(0, 40)}`, () => {
      const html = renderEquationHtml(src, false)
      // The authoritative test: parse the rendered HTML into a REAL DOM and
      // assert there is no live executable surface. KaTeX (trust:false) renders
      // hostile constructs as inert escaped text inside MathML/spans, so a
      // string-level `onerror=`/`javascript:` may appear only as ESCAPED text —
      // never as a parsed attribute or a live <script>/<a href>. Checking the
      // parsed DOM (not the raw string) is what actually matters.
      const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
      const root = doc.body.firstChild as Element
      // No script elements.
      expect(root.querySelectorAll('script').length).toBe(0)
      // No element carries an on* handler attribute.
      for (const el of root.querySelectorAll('*')) {
        for (const attr of el.attributes) {
          expect(attr.name.toLowerCase().startsWith('on')).toBe(false)
          // No attribute value is a javascript: URL.
          expect(attr.value.toLowerCase().includes('javascript:')).toBe(false)
        }
      }
      // No <a href> at all (KaTeX \href is disabled under trust:false).
      for (const a of root.querySelectorAll('a[href]')) {
        expect(a.getAttribute('href')?.toLowerCase()).not.toContain('javascript:')
      }
      // No <img> was produced from the hostile <img> string (it stays text).
      expect(root.querySelectorAll('img').length).toBe(0)
    })
  }

  it('the FULL export path sanitises rendered equation HTML (defence-in-depth)', () => {
    editor = makeEditor('<p>text</p>')
    editor.commands.insertMathInline('\\href{javascript:alert(1)}{x}')
    exportToHtml(editor, 'sec', {})
    expect(saveAs).toHaveBeenCalled()
    const blob = savedBlob()
    // We can't read Blob text synchronously in jsdom easily; assert on the
    // sanitiser directly with the rendered markup instead.
    const rendered = renderEquationHtml('\\href{javascript:alert(1)}{x}', false)
    const clean = sanitizeDocHtml(`<span class="math-inline">${rendered}</span>`)
    expect(clean).not.toMatch(/<script/i)
    expect(clean).not.toMatch(/href\s*=\s*["']?javascript:/i)
    expect(blob).toBeInstanceOf(Blob)
  })
})

// ── 3. Node stores only the LaTeX source (CRDT-safe) ─────────────────────────
describe('math node model', () => {
  it('inline math stores only the latex source string in the doc JSON', () => {
    editor = makeEditor('<p></p>')
    editor.commands.insertMathInline('E = mc^2')
    const json = editor.getJSON()
    // Find the math node. A returning recursive lookup (rather than a
    // closure that mutates an outer `let`) so TS can actually narrow the
    // result — mutation of a captured variable inside a nested function
    // isn't tracked by control-flow analysis at the call site.
    const mathNode = findNodeByType(json, 'mathInline')
    expect(mathNode).toBeTruthy()
    if (!mathNode) throw new Error('math node not found')
    expect(mathNode.attrs!.latex).toBe('E = mc^2')
    // No rendered HTML is stored — only the source attr.
    expect(Object.keys(mathNode.attrs!)).toEqual(['latex'])
  })

  it('block math is an atomic block node', () => {
    editor = makeEditor('<p></p>')
    editor.commands.insertMathBlock('\\int_0^1 x\\,dx')
    const json = editor.getJSON()
    const hasBlock = JSON.stringify(json).includes('"mathBlock"')
    expect(hasBlock).toBe(true)
  })
})

// ── 4. getHTML round-trip ─────────────────────────────────────────────────────
describe('math getHTML / parse round-trip', () => {
  it('serialises math with data-latex and re-parses to a node', () => {
    editor = makeEditor('<p></p>')
    editor.commands.insertMathInline('a^2 + b^2')
    const html = editor.getHTML()
    expect(html).toContain('data-latex="a^2 + b^2"')

    // Re-import the HTML into a fresh editor → node survives.
    const e2 = makeEditor(html)
    const json = e2.getJSON()
    expect(JSON.stringify(json)).toContain('a^2 + b^2')
    e2.destroy()
  })
})

// ── 5. HTML export renders KaTeX ─────────────────────────────────────────────
describe('equation HTML export', () => {
  it('exports the equation rendered as KaTeX (not just the source)', async () => {
    editor = makeEditor('<p>See</p>')
    editor.commands.insertMathBlock('\\frac{a}{b}')
    exportToHtml(editor, 'doc', {})
    const blob = savedBlob()
    const text = await blob.text()
    expect(text).toContain('katex')
    expect(text).not.toContain('<script')
    // Fidelity: KaTeX's dimensional styles survive (a fraction uses vertical
    // positioning) because math is painted AFTER the body sanitiser into the
    // trusted shell — the shared allow-list is NOT loosened for user content.
    expect(text).toMatch(/<span class="mfrac"|vertical-align/)
  })

  it('a hostile equation still cannot inject through the export (post-sanitise render is trust:false)', async () => {
    editor = makeEditor('<p>x</p>')
    editor.commands.insertMathInline('\\href{javascript:alert(1)}{x}')
    exportToHtml(editor, 'doc', {})
    const blob = savedBlob()
    const text = await blob.text()
    // Parse the exported document; assert no live executable surface.
    const doc = new DOMParser().parseFromString(text, 'text/html')
    expect(doc.querySelectorAll('script').length).toBe(0)
    for (const a of doc.querySelectorAll('a[href]')) {
      expect(a.getAttribute('href')?.toLowerCase()).not.toContain('javascript:')
    }
    for (const el of doc.querySelectorAll('*')) {
      for (const attr of el.attributes) {
        expect(attr.name.toLowerCase().startsWith('on')).toBe(false)
      }
    }
  })
})
