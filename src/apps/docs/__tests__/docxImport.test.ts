/**
 * docxImport.test.js — a HOSTILE .docx must be neutralised on import.
 * ----------------------------------------------------------------------------
 * The Docs import path is: mammoth (docx→html) → `_html` → sanitizeDocHtml (the
 * DocsEditor.resolveContent trust boundary) → TipTap. This test hand-builds a
 * malicious WordprocessingML package (a javascript: hyperlink) and drives it
 * through the SAME two steps, asserting the exec scheme is gone and the benign
 * content survives.
 */
import { describe, it, expect, vi } from 'vitest'
import JSZip from 'jszip'
import mammoth from 'mammoth'
import { sanitizeDocHtml } from '../../../lib/sanitize.js'
import { convertToDocContent } from '../../../lib/importFile.js'
import { ImportError, MAX_SINGLE_ENTRY } from '../../../lib/importBounds.js'
import { buildLyingZip } from '../../../lib/__tests__/zipBombFixture.js'

async function hostileDocx() {
  const zip = new JSZip()
  zip.file('[Content_Types].xml',
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`)
  zip.file('_rels/.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)
  zip.file('word/document.xml',
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>` +
    `<w:p><w:hyperlink r:id="rIdEvil"><w:r><w:t>clickme</w:t></w:r></w:hyperlink></w:p>` +
    `<w:p><w:r><w:t>Hello Doc Body</w:t></w:r></w:p>` +
    `</w:body></w:document>`)
  zip.file('word/_rels/document.xml.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rIdEvil" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" ` +
    `Target="javascript:alert(document.cookie)" TargetMode="External"/></Relationships>`)
  // nodebuffer so mammoth's node build (used by vitest) can open it; the app
  // uses mammoth's browser build with { arrayBuffer } — same converter, same HTML.
  return zip.generateAsync({ type: 'nodebuffer' })
}

describe('docx import — hostile input neutralised at the sanitizer boundary', () => {
  it('strips a javascript: hyperlink but keeps the document text', async () => {
    const buf = await hostileDocx()
    const { value: rawHtml } = await mammoth.convertToHtml({ buffer: buf })
    // Mammoth faithfully carries the exec-scheme href through (it is a converter,
    // not a sanitiser) — proving the sanitiser, not the converter, is the guard.
    const clean = sanitizeDocHtml(rawHtml)
    expect(clean).not.toMatch(/javascript:/i)
    expect(clean).not.toMatch(/<script/i)
    expect(clean).toContain('Hello Doc Body')   // benign content survives
    expect(clean).toContain('clickme')          // link text kept, href neutralised
  })
})

describe('docx import — zip-bomb rejected BEFORE mammoth parses', () => {
  // The .docx path (mammoth) inflates the archive itself, so the odt/pptx
  // mid-stream inflate cap never sees it. assertArchiveBounds must run first and
  // reject a bomb before a single byte reaches mammoth (client-side DoS guard).
  it('rejects a lying-central-directory oversize .docx before the heavy parse', async () => {
    // A .docx whose central directory DECLARES a 200 MB entry (> MAX_SINGLE_ENTRY)
    // while the real bytes are trivial: the CD pre-check rejects it without ever
    // inflating, and mammoth is never invoked.
    const bomb = buildLyingZip('word/document.xml', Buffer.from('<x/>'), 200 * 1024 * 1024)
    expect(200 * 1024 * 1024).toBeGreaterThan(MAX_SINGLE_ENTRY)
    const spy = vi.spyOn(mammoth, 'convertToHtml')
    // buildLyingZip returns Uint8Array<ArrayBufferLike>; File's BlobPart wants
    // Uint8Array<ArrayBuffer> specifically (rules out a SharedArrayBuffer
    // backing, which this never has) — a real BlobPart at runtime either way.
    const file = new File([bomb as BlobPart], 'bomb.docx')
    await expect(convertToDocContent(file)).rejects.toThrow(ImportError)
    expect(spy).not.toHaveBeenCalled()   // parser never reached
    spy.mockRestore()
  })
})
