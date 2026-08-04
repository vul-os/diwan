/**
 * docxHyperlink.test.js — DOCX export hyperlink fidelity (deep/office).
 *
 * inlineNodes handled bold/italic/underline/color/size/font marks but had NO
 * case for the `link` mark, so a hyperlink's anchor text survived to .docx while
 * its URL was silently dropped — a broken-reference data loss (and inconsistent
 * with the HTML/Markdown exports, which keep links). These pin the fix: a linked
 * run is wrapped in a docx ExternalHyperlink; unsafe schemes degrade to plain text.
 */
import { describe, it, expect } from 'vitest'
import { ExternalHyperlink, TextRun } from 'docx'
import { inlineNodes } from '../docsExport.js'

const linkedNode = (text: string, href: string) => ({
  type: 'text', text, marks: [{ type: 'link', attrs: { href } }],
})

describe('DOCX export — hyperlink round-trip', () => {
  it('wraps a linked run in an ExternalHyperlink carrying the href', () => {
    const [node] = inlineNodes([linkedNode('Vulos', 'https://vulos.app/docs')])
    expect(node).toBeInstanceOf(ExternalHyperlink)
    // docx stores the target on the hyperlink options. toBeInstanceOf is a
    // runtime check tsc can't see as a type guard, hence the cast.
    expect((node as ExternalHyperlink).options.link).toBe('https://vulos.app/docs')
  })

  it('supports mailto: links', () => {
    const [node] = inlineNodes([linkedNode('mail', 'mailto:a@b.com')])
    expect(node).toBeInstanceOf(ExternalHyperlink)
    expect((node as ExternalHyperlink).options.link).toBe('mailto:a@b.com')
  })

  it('drops an unsafe javascript: scheme to plain text (no live link)', () => {
    const [node] = inlineNodes([linkedNode('x', 'javascript:alert(1)')])
    expect(node).toBeInstanceOf(TextRun)
    expect(node).not.toBeInstanceOf(ExternalHyperlink)
  })

  it('an unlinked run stays a plain TextRun', () => {
    const [node] = inlineNodes([{ type: 'text', text: 'plain', marks: [] }])
    expect(node).toBeInstanceOf(TextRun)
    expect(node).not.toBeInstanceOf(ExternalHyperlink)
  })
})
