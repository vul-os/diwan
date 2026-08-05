/**
 * P2 — Headers & footers (model, fields, sanitisation, export).
 *
 * Coverage:
 *   1. normalizeHeaderFooter validates + SANITISES cell text to plain text
 *      (this region is authored content → no markup may survive).
 *   2. resolveFields substitutes {{page}}/{{pages}}/{{title}}/{{date}}.
 *   3. bandsForPage honours enabled / first-page-different / odd-even.
 *   4. Export: DOCX + HTML export include the header/footer with a page-number
 *      field, and the page-setup geometry.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'

import {
  normalizeHeaderFooter, resolveFields, bandsForPage,
  sanitizeHeaderText, hasHeaderFooterContent,
} from '../headerFooter.js'
import { exportToHtml, exportToDocx } from '../docsExport.js'
import { saveAs } from 'file-saver'

vi.mock('file-saver', () => ({ saveAs: vi.fn() }))

function makeEditor(): Editor {
  return new Editor({
    extensions: [Document, Paragraph, Text],
    content: '<p>Body</p>',
  })
}

// A saveAs Blob argument narrowed away from the `Blob | string` union the real
// file-saver signature allows — this suite only ever hands it a Blob.
function firstSavedBlob(): Blob {
  const data = vi.mocked(saveAs).mock.calls[0]?.[0]
  if (!(data instanceof Blob)) throw new Error('expected saveAs to be called with a Blob')
  return data
}

let editor: Editor | null = null
afterEach(() => { editor?.destroy(); editor = null; vi.clearAllMocks() })

// ── 1. Sanitisation / normalisation ──────────────────────────────────────────
describe('header/footer normalisation (security)', () => {
  it('strips markup from cell text (plain text only)', () => {
    expect(sanitizeHeaderText('<b>hi</b>')).toBe('hi')
    expect(sanitizeHeaderText('<script>alert(1)</script>x')).toBe('x')
    expect(sanitizeHeaderText('<img src=x onerror=alert(1)>')).toBe('')
  })

  it('normalizeHeaderFooter sanitises every cell + coerces flags', () => {
    const cfg = normalizeHeaderFooter({
      enabled: 'yes',
      header: { left: '<b>Title</b>', center: 'ok', right: '<script>x</script>' },
      footer: { center: 'Page {{page}}' },
      differentFirstPage: 1,
      oddEven: 0,
    })
    expect(cfg.enabled).toBe(true)
    expect(cfg.header.left).toBe('Title')
    expect(cfg.header.right).toBe('')
    expect(cfg.footer.center).toBe('Page {{page}}')  // field token preserved
    expect(cfg.differentFirstPage).toBe(true)
    expect(cfg.oddEven).toBe(false)
  })

  it('bounds cell length', () => {
    const long = 'a'.repeat(2000)
    expect(sanitizeHeaderText(long).length).toBeLessThanOrEqual(500)
  })

  it('handles null / garbage input', () => {
    expect(normalizeHeaderFooter(null).enabled).toBe(false)
    expect(normalizeHeaderFooter('x').header.left).toBe('')
  })
})

// ── 2. Field resolution ───────────────────────────────────────────────────────
describe('resolveFields', () => {
  it('substitutes page / pages / title', () => {
    const out = resolveFields('{{title}} — {{page}} of {{pages}}', { title: 'Report', page: 2, pages: 5 })
    expect(out).toBe('Report — 2 of 5')
  })
  it('is case-insensitive + whitespace-tolerant', () => {
    expect(resolveFields('{{ PAGE }}', { page: 3 })).toBe('3')
  })
  it('resolves date when not provided', () => {
    const out = resolveFields('{{date}}', {})
    expect(out.length).toBeGreaterThan(0)
    expect(out).not.toContain('{{')
  })
})

// ── 3. bandsForPage ──────────────────────────────────────────────────────────
describe('bandsForPage', () => {
  const cfg = normalizeHeaderFooter({
    enabled: true,
    header: { left: 'L', center: '{{title}}', right: 'R' },
    footer: { center: 'p{{page}}' },
  })

  it('resolves fields per page', () => {
    const b = bandsForPage(cfg, 3, { title: 'Doc', pages: 4 })
    expect(b.header.center).toBe('Doc')
    expect(b.footer.center).toBe('p3')
  })

  it('suppresses on page 1 when differentFirstPage', () => {
    const c = normalizeHeaderFooter({ ...cfg, differentFirstPage: true })
    const b1 = bandsForPage(c, 1, { title: 'Doc' })
    expect(b1.header.left).toBe('')
    expect(b1.footer.center).toBe('')
    const b2 = bandsForPage(c, 2, { title: 'Doc' })
    expect(b2.header.left).toBe('L')
  })

  it('mirrors left/right on even pages when oddEven', () => {
    const c = normalizeHeaderFooter({ ...cfg, oddEven: true })
    const odd = bandsForPage(c, 1, { title: 'Doc' })
    const even = bandsForPage(c, 2, { title: 'Doc' })
    expect(odd.header.left).toBe('L')
    expect(even.header.left).toBe('R') // swapped
    expect(even.header.right).toBe('L')
  })

  it('returns empty bands when disabled', () => {
    const c = normalizeHeaderFooter({ enabled: false, header: { left: 'x' } })
    expect(bandsForPage(c, 1, {}).header.left).toBe('')
  })

  it('hasHeaderFooterContent detects populated bands', () => {
    expect(hasHeaderFooterContent(cfg)).toBe(true)
    expect(hasHeaderFooterContent(normalizeHeaderFooter({ enabled: true }))).toBe(false)
  })
})

// ── 4. Export includes headers/footers + page setup ──────────────────────────
describe('header/footer + page-setup export', () => {
  it('HTML export includes @page geometry and running header/footer', async () => {
    editor = makeEditor()
    exportToHtml(editor, 'MyDoc', {
      pageSetup: { size: 'a4', orientation: 'landscape', margins: { top: 1, right: 1, bottom: 1, left: 1 } },
      headerFooter: { enabled: true, header: { center: '{{title}}' }, footer: { right: 'Page {{page}}' } },
    })
    const blob = firstSavedBlob()
    const text = await blob.text()
    expect(text).toMatch(/@page/)
    expect(text).toMatch(/@top-center|@bottom-right/)
    // {{page}} → counter(page) for the print engine.
    expect(text).toContain('counter(page)')
    // Title field resolved into the running element.
    expect(text).toContain('MyDoc')
  })

  it('a hostile title cannot break out of the <style> block via {{title}} (</style> breakout)', async () => {
    editor = makeEditor()
    // The HTML tokenizer ends a <style> element at the first literal </style>
    // regardless of CSS string quoting — so a title carrying </style><script>
    // interpolated into the CSS content: sink must be neutralised (cssStr
    // escapes < and > as \3c /\3e).
    const hostile = 'report</style><script>alert(document.domain)</script>'
    exportToHtml(editor, hostile, {
      headerFooter: { enabled: true, header: { center: '{{title}}' } },
    })
    const blob = firstSavedBlob()
    const text = await blob.text()
    // No literal </style> may appear before the real closing tag's position
    // other than the genuine one; concretely: no <script> element must survive.
    const doc = new DOMParser().parseFromString(text, 'text/html')
    expect(doc.querySelectorAll('script').length).toBe(0)
    // And the raw text carries the escaped form, not a live closing tag, inside
    // the content: declaration.
    expect(text).not.toContain('content: "report</style>')
  })

  it('HTML export escapes header/footer text (no markup injection)', async () => {
    editor = makeEditor()
    exportToHtml(editor, '"><script>alert(1)</script>', {
      headerFooter: { enabled: true, header: { left: 'safe' } },
    })
    const blob = firstSavedBlob()
    const text = await blob.text()
    // The hostile filename must be escaped in <title> / running elements.
    expect(text).not.toContain('<script>alert(1)</script>')
  })

  it('DOCX export runs without throwing with header/footer + page setup', async () => {
    editor = makeEditor()
    await exportToDocx(editor, 'Doc', {
      pageSetup: { size: 'legal', orientation: 'portrait' },
      headerFooter: { enabled: true, footer: { center: 'Page {{page}} of {{pages}}' } },
    })
    expect(saveAs).toHaveBeenCalled()
    expect(firstSavedBlob()).toBeInstanceOf(Blob)
  })
})
