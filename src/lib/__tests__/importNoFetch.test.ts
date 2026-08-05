/**
 * importNoFetch.test.js — PROVE that importing an untrusted office file never
 * triggers a network request (no SSRF / tracking-pixel / external-DTD fetch).
 *
 * We install a hard trap over every network primitive (fetch, XMLHttpRequest,
 * WebSocket, EventSource) for the duration of each import. A hostile document
 * carrying a remote <img>/relationship/xlink:href MUST have that reference
 * dropped, and NONE of the traps may fire. This is the counterpart to the
 * per-importer "the ref is absent from the output" assertions — here we assert
 * the stronger property: no fetch was even attempted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import JSZip from 'jszip'
import mammoth from 'mammoth'
import { odtToHtml } from '../../apps/docs/odtImport.js'
import { pptxToSlides, odpToSlides } from '../../apps/slides/slidesImport.js'
import { workbookToSheets } from '../../apps/sheets/sheetsImport.js'

let traps: ReturnType<typeof vi.fn<(...args: unknown[]) => never>>
let savedGlobals: { fetch: typeof fetch; XMLHttpRequest: typeof XMLHttpRequest; WebSocket: typeof WebSocket; EventSource: typeof EventSource }

beforeEach(() => {
  traps = vi.fn<(...args: unknown[]) => never>(() => { throw new Error('NETWORK ACCESS during import — SSRF/tracking risk') })
  const G = globalThis
  savedGlobals = {
    fetch: G.fetch,
    XMLHttpRequest: G.XMLHttpRequest,
    WebSocket: G.WebSocket,
    EventSource: G.EventSource,
  }
  G.fetch = ((...a: unknown[]) => traps(...a)) as typeof fetch
  // XHR: trap open() (the point a URL is supplied). Deliberately minimal test
  // doubles — not real XMLHttpRequest/WebSocket/EventSource implementations —
  // hence the assertions past their real constructor types.
  G.XMLHttpRequest = class { open(...a: unknown[]) { traps(...a) } send() { traps() } setRequestHeader() {} } as unknown as typeof XMLHttpRequest
  G.WebSocket = class { constructor(...a: unknown[]) { traps(...a) } } as unknown as typeof WebSocket
  G.EventSource = class { constructor(...a: unknown[]) { traps(...a) } } as unknown as typeof EventSource
})

afterEach(() => {
  Object.assign(globalThis, savedGlobals)
})

const ODF_NS = [
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"',
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"',
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"',
  'xmlns:xlink="http://www.w3.org/1999/xlink"',
].join(' ')

describe('no network fetch during import', () => {
  it('ODT with a remote image + external-entity DOCTYPE fetches nothing', async () => {
    const content = `<?xml version="1.0"?>
      <!DOCTYPE office:document-content SYSTEM "http://evil.example/x.dtd">
      <office:document-content ${ODF_NS}><office:body><office:text>
        <text:p><draw:frame><draw:image xlink:href="https://evil.example/track.png"/></draw:frame></text:p>
        <text:p>hello</text:p>
      </office:text></office:body></office:document-content>`
    const zip = new JSZip()
    zip.file('mimetype', 'application/vnd.oasis.opendocument.text')
    zip.file('content.xml', content)
    const ab = await zip.generateAsync({ type: 'arraybuffer' })
    const html = await odtToHtml(ab, 'evil.odt')
    expect(traps).not.toHaveBeenCalled()
    expect(html).not.toContain('evil.example')
    expect(html).toContain('hello')
  })

  it('PPTX with an external-URL image relationship fetches nothing', async () => {
    const zip = new JSZip()
    zip.file('ppt/presentation.xml',
      `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
      `<p:sldSz cx="12192000" cy="6858000"/></p:presentation>`)
    zip.file('ppt/slides/slide1.xml',
      `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ` +
      `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<p:cSld><p:spTree><p:pic><p:blipFill><a:blip r:embed="rId9"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>`)
    zip.file('ppt/slides/_rels/slide1.xml.rels',
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId9" Type="image" Target="https://evil.example/track.png" TargetMode="External"/></Relationships>`)
    const ab = await zip.generateAsync({ type: 'arraybuffer' })
    const deck = await pptxToSlides(ab, 'evil.pptx')
    expect(traps).not.toHaveBeenCalled()
    const imgs = deck.slides.flatMap((s) => s.objects).filter((o) => o.type === 'image')
    expect(imgs).toHaveLength(0)   // external image dropped, never fetched
  })

  it('ODP with a remote image xlink:href fetches nothing', async () => {
    const content = `<?xml version="1.0"?>
      <office:document-content ${ODF_NS}><office:body><office:presentation>
        <draw:page><draw:frame svg:x="1in" svg:y="1in" svg:width="4in" svg:height="3in">
          <draw:image xlink:href="http://evil.example/track.png"/>
        </draw:frame></draw:page>
      </office:presentation></office:body></office:document-content>`
    const zip = new JSZip()
    zip.file('mimetype', 'application/vnd.oasis.opendocument.presentation')
    zip.file('content.xml', content)
    const ab = await zip.generateAsync({ type: 'arraybuffer' })
    const deck = await odpToSlides(ab, 'evil.odp')
    expect(traps).not.toHaveBeenCalled()
    const imgs = deck.slides.flatMap((s) => s.objects).filter((o) => o.type === 'image')
    expect(imgs).toHaveLength(0)
  })

  it('DOCX (mammoth) with an external image relationship fetches nothing', async () => {
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
      `<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
      `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData>` +
      `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill>` +
      `<a:blip r:link="rIdImg"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>` +
      `<w:p><w:r><w:t>Body text</w:t></w:r></w:p></w:body></w:document>`)
    zip.file('word/_rels/document.xml.rels',
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" ` +
      `Target="https://evil.example/track.png" TargetMode="External"/></Relationships>`)
    const buf = await zip.generateAsync({ type: 'nodebuffer' })
    const { value: html } = await mammoth.convertToHtml({ buffer: buf })
    expect(traps).not.toHaveBeenCalled()
    expect(html).not.toContain('evil.example')   // external r:link image not fetched/emitted
    expect(html).toContain('Body text')
  })

  it('XLSX (SheetJS) with an XXE external entity fetches nothing', async () => {
    // A minimal xlsx whose sharedStrings declares an external SYSTEM entity.
    const zip = new JSZip()
    zip.file('[Content_Types].xml',
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`)
    zip.file('_rels/.rels',
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`)
    zip.file('xl/workbook.xml',
      `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
      `<sheet name="S1" sheetId="1" r:id="rId1"/></sheets></workbook>`)
    zip.file('xl/_rels/workbook.xml.rels',
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`)
    zip.file('xl/worksheets/sheet1.xml',
      `<?xml version="1.0"?><!DOCTYPE x [ <!ENTITY xxe SYSTEM "http://evil.example/x"> ]>` +
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
      `<row r="1"><c r="A1" t="inlineStr"><is><t>&xxe;</t></is></c></row></sheetData></worksheet>`)
    const ab = await zip.generateAsync({ type: 'arraybuffer' })
    let sheets
    try { sheets = workbookToSheets(ab, 'evil.xlsx') } catch { /* fail-closed parse is fine */ }
    expect(traps).not.toHaveBeenCalled()
    if (sheets) {
      const text = JSON.stringify(sheets)
      expect(text).not.toMatch(/root:|evil\.example/)
    }
  })
})
