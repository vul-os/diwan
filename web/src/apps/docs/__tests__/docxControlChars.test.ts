import { describe, it, expect } from 'vitest'
import { TextRun } from 'docx'
import { inlineNodes } from '../docsExport.js'

// deep/office2: a document run whose text carried an XML-1.0-illegal control char
// (VT/FF/NUL/…) was written into <w:t> verbatim by the docx library, so Word
// refused/"repaired" the exported .docx (corrupt document.xml). inlineNodes now
// funnels all run text through stripXmlInvalidChars. Assert the control byte is
// gone from the produced run while legit text survives.
const VT = String.fromCharCode(0x0B)
const NUL = String.fromCharCode(0x00)

function runHasChar(run: unknown, ch: string): boolean {
  return JSON.stringify(run).includes(ch)
}

describe('DOCX export — XML-illegal control chars stripped from runs', () => {
  it('a plain run drops VT/NUL but keeps the surrounding text', () => {
    const [run] = inlineNodes([{ type: 'text', text: 'A' + VT + 'B' + NUL + 'C', marks: [] }])
    expect(run).toBeInstanceOf(TextRun)
    expect(runHasChar(run, VT)).toBe(false)
    expect(runHasChar(run, NUL)).toBe(false)
    expect(runHasChar(run, 'A')).toBe(true)
    expect(runHasChar(run, 'C')).toBe(true)
  })

  it('an inline equation LaTeX run is also sanitised', () => {
    const [run] = inlineNodes([{ type: 'mathInline', attrs: { latex: 'x' + VT + '=1' } }])
    expect(runHasChar(run, VT)).toBe(false)
  })
})
