/**
 * odtImport.test.js — .odt → HTML fidelity + security through sanitizeDocHtml
 * (the Docs import trust boundary), plus odt export round-trip.
 */
import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import type { Editor, JSONContent } from '@tiptap/react'
import { odtToHtml } from '../odtImport.js'
import { buildOdtBlob } from '../odtExport.js'
import { sanitizeDocHtml } from '../../../lib/sanitize.js'
import { ImportError } from '../../../lib/importBounds.js'

// buildOdtBlob only ever calls editor.getJSON() — a minimal stub covers it
// without constructing a real TipTap Editor, same pattern used elsewhere for
// narrow interface mocks (cast through a local type, not `any`).
type MockEditor = { getJSON: () => JSONContent }
const asEditor = (e: MockEditor): Editor => e as unknown as Editor

const NS = [
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"',
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"',
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"',
  'xmlns:xlink="http://www.w3.org/1999/xlink"',
].join(' ')

async function makeOdt(bodyXml: string, { withPicture = false } = {}): Promise<ArrayBuffer> {
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${NS}>
  <office:automatic-styles>
    <style:style style:name="Bold" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>
    <style:style style:name="Ital" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>
  </office:automatic-styles>
  <office:body><office:text>${bodyXml}</office:text></office:body>
</office:document-content>`
  const zip = new JSZip()
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text')
  zip.file('content.xml', content)
  if (withPicture) zip.file('Pictures/img.png', new Uint8Array([137, 80, 78, 71]))
  return zip.generateAsync({ type: 'arraybuffer' })
}

describe('odtToHtml — fidelity', () => {
  it('maps headings, paragraphs and bold/italic runs', async () => {
    const ab = await makeOdt(
      `<text:h text:outline-level="2">Title</text:h>` +
      `<text:p>Hello <text:span text:style-name="Bold">world</text:span> and ` +
      `<text:span text:style-name="Ital">emphasis</text:span></text:p>`
    )
    const html = await odtToHtml(ab, 'd.odt')
    expect(html).toContain('<h2>Title</h2>')
    expect(html).toContain('<strong>world</strong>')
    expect(html).toContain('<em>emphasis</em>')
  })

  it('maps lists and tables', async () => {
    const ab = await makeOdt(
      `<text:list><text:list-item><text:p>one</text:p></text:list-item>` +
      `<text:list-item><text:p>two</text:p></text:list-item></text:list>` +
      `<table:table><table:table-row><table:table-cell><text:p>c1</text:p></table:table-cell>` +
      `<table:table-cell><text:p>c2</text:p></table:table-cell></table:table-row></table:table>`
    )
    const html = await odtToHtml(ab, 'd.odt')
    expect(html).toContain('<ul>')
    expect(html).toContain('<li>')
    expect(html).toContain('one')
    expect(html).toContain('<table>')
    expect(html).toContain('c1')
  })

  it('embeds a Pictures/ raster image as a bounded data: URI (no fetch)', async () => {
    const ab = await makeOdt(
      `<text:p><draw:frame><draw:image xlink:href="Pictures/img.png"/></draw:frame></text:p>`,
      { withPicture: true }
    )
    const html = await odtToHtml(ab, 'd.odt')
    expect(html).toMatch(/<img src="data:image\/png;base64,/)
  })
})

describe('odtToHtml — security (via sanitizeDocHtml boundary)', () => {
  it('drops a javascript: link and survives sanitisation with no script', async () => {
    const ab = await makeOdt(
      `<text:p><text:a xlink:href="javascript:alert(1)">click</text:a></text:p>` +
      `<text:p><text:a xlink:href="https://example.com">safe</text:a></text:p>`
    )
    const clean = sanitizeDocHtml(await odtToHtml(ab, 'd.odt'))
    expect(clean).not.toMatch(/javascript:/i)
    expect(clean).not.toMatch(/<script/i)
    expect(clean).toContain('click')                 // text preserved, link dropped
    expect(clean).toContain('href="https://example.com"')
  })

  it('does NOT fetch/emit an external image reference', async () => {
    const ab = await makeOdt(
      `<text:p><draw:frame><draw:image xlink:href="https://evil.example/x.png"/></draw:frame></text:p>`
    )
    const html = await odtToHtml(ab, 'd.odt')
    expect(html).not.toContain('evil.example')       // remote ref dropped, never fetched
  })

  it('does NOT resolve a traversal image href', async () => {
    const ab = await makeOdt(
      `<text:p><draw:frame><draw:image xlink:href="../../secret.png"/></draw:frame></text:p>`
    )
    const html = await odtToHtml(ab, 'd.odt')
    expect(html).not.toContain('secret')
  })

  it('rejects a zip with no content.xml', async () => {
    const zip = new JSZip()
    zip.file('mimetype', 'application/vnd.oasis.opendocument.text')
    const ab = await zip.generateAsync({ type: 'arraybuffer' })
    await expect(odtToHtml(ab, 'bad.odt')).rejects.toThrow(ImportError)
  })
})

describe('exportToOdt — round-trip', () => {
  it('produces a valid ODT whose content re-imports (structure survives)', async () => {
    const editor = asEditor({
      getJSON: () => ({
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Doc Title' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Bold', marks: [{ type: 'bold' }] }, { type: 'text', text: ' plain' }] },
        ],
      }),
    })
    const blob = await buildOdtBlob(editor)
    const ab = await blob.arrayBuffer()
    const html = await odtToHtml(ab, 'MyDoc.odt')
    expect(html).toContain('Doc Title')
    expect(html).toContain('<strong>Bold</strong>')
  })
})
