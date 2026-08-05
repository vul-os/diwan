/**
 * slidesImport.test.js — .pptx / .odp → positioned objects, fidelity + security.
 */
import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { pptxToSlides, odpToSlides } from '../slidesImport.js'
import { sanitizeObjects, type TextSlideObject, type ImageSlideObject } from '../slideObjects'

const RASTER = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

// ── PPTX fixture ───────────────────────────────────────────────────────────────
function slideXml() {
  return `<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
 <p:cSld><p:spTree>
  <p:sp>
   <p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
   <p:spPr><a:xfrm><a:off x="838200" y="365760"/><a:ext cx="10515600" cy="1325563"/></a:xfrm></p:spPr>
   <p:txBody><a:p><a:r><a:t>My Title</a:t></a:r></a:p></p:txBody>
  </p:sp>
  <p:sp>
   <p:spPr><a:xfrm><a:off x="838200" y="1825625"/><a:ext cx="10515600" cy="4351338"/></a:xfrm></p:spPr>
   <p:txBody>
    <a:p><a:r><a:rPr b="1"/><a:t>Point A</a:t></a:r></a:p>
    <a:p><a:r><a:t>&lt;script&gt;alert(1)&lt;/script&gt;</a:t></a:r></a:p>
   </p:txBody>
  </p:sp>
  <p:pic>
   <p:blipFill><a:blip r:embed="rId2"/></p:blipFill>
   <p:spPr><a:xfrm><a:off x="3000000" y="2000000"/><a:ext cx="3000000" cy="2000000"/></a:xfrm></p:spPr>
  </p:pic>
 </p:spTree></p:cSld>
</p:sld>`
}

async function makePptx() {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types/>')
  zip.file('ppt/presentation.xml',
    `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
    `<p:sldSz cx="12192000" cy="6858000"/></p:presentation>`)
  zip.file('ppt/slides/slide1.xml', slideXml())
  zip.file('ppt/slides/_rels/slide1.xml.rels',
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId2" Type="image" Target="../media/image1.png"/></Relationships>`)
  zip.file('ppt/media/image1.png', RASTER)
  zip.file('ppt/notesSlides/notesSlide1.xml',
    `<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ` +
    `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:t>Speaker note here</a:t></p:notes>`)
  return zip.generateAsync({ type: 'arraybuffer' })
}

describe('pptxToSlides — fidelity', () => {
  it('maps a title, a body bullet list, an image, and notes with positions', async () => {
    const deck = await pptxToSlides(await makePptx(), 'd.pptx')
    expect(deck.slides).toHaveLength(1)
    const objs = deck.slides[0].objects
    const title = objs.find((o) => o.type === 'text' && /<h2>/.test(o.html)) as TextSlideObject | undefined
    expect(title).toBeTruthy()
    expect(title!.html).toContain('My Title')
    // Title geometry maps from EMU offsets → normalized fractions in [0,1].
    expect(title!.x).toBeGreaterThan(0)
    expect(title!.x).toBeLessThan(0.2)
    expect(title!.y).toBeGreaterThan(0)

    const body = objs.find((o) => o.type === 'text' && /Point A/.test(o.html)) as TextSlideObject | undefined
    expect(body!.html).toContain('<strong>Point A</strong>')

    const img = objs.find((o) => o.type === 'image')
    expect(img!.src).toMatch(/^data:image\/png;base64,/)
    expect(img!.w).toBeCloseTo(3000000 / 12192000, 3)

    expect(deck.slides[0].notes).toContain('Speaker note here')
  })
})

describe('pptxToSlides — security', () => {
  it('script-like run text survives sanitizeObjects with no live script', async () => {
    const deck = await pptxToSlides(await makePptx(), 'd.pptx')
    const clean = sanitizeObjects(deck.slides[0].objects)
    const joined = clean.map((o) => (o as TextSlideObject).html || (o as ImageSlideObject).src || '').join(' ')
    // The run text is XML-escaped as it is lifted from the part, so it renders as
    // visible literal text — never a live <script> element.
    expect(joined).not.toMatch(/<script/i)
    expect(joined).toContain('&lt;script&gt;')
  })
})

// ── ODP fixture ────────────────────────────────────────────────────────────────
async function makeOdp() {
  const NS = [
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
    'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
    'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"',
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
    'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"',
    'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"',
    'xmlns:xlink="http://www.w3.org/1999/xlink"',
  ].join(' ')
  const content = `<?xml version="1.0"?>
<office:document-content ${NS}>
 <office:automatic-styles>
  <style:page-layout-properties fo:page-width="10in" fo:page-height="7.5in"/>
 </office:automatic-styles>
 <office:body><office:presentation>
  <draw:page>
   <draw:frame svg:x="1in" svg:y="0.5in" svg:width="8in" svg:height="1in">
    <draw:text-box><text:h>ODP Title</text:h></draw:text-box>
   </draw:frame>
   <draw:frame svg:x="2in" svg:y="2in" svg:width="4in" svg:height="3in">
    <draw:image xlink:href="Pictures/p.png"/>
   </draw:frame>
  </draw:page>
 </office:presentation></office:body>
</office:document-content>`
  const zip = new JSZip()
  zip.file('mimetype', 'application/vnd.oasis.opendocument.presentation')
  zip.file('content.xml', content)
  zip.file('Pictures/p.png', RASTER)
  return zip.generateAsync({ type: 'arraybuffer' })
}

describe('odpToSlides — fidelity', () => {
  it('maps a text frame and an image frame with positions', async () => {
    const deck = await odpToSlides(await makeOdp(), 'd.odp')
    expect(deck.slides).toHaveLength(1)
    const objs = deck.slides[0].objects
    const text = objs.find((o) => o.type === 'text')
    expect(text!.html).toContain('ODP Title')
    expect(text!.x).toBeCloseTo(1 / 10, 2)      // 1in of a 10in page
    expect(text!.y).toBeCloseTo(0.5 / 7.5, 2)
    const img = objs.find((o) => o.type === 'image')
    expect(img!.src).toMatch(/^data:image\/png;base64,/)
    expect(img!.w).toBeCloseTo(4 / 10, 2)
  })

  it('imported objects pass sanitizeObjects unchanged in count', async () => {
    const deck = await odpToSlides(await makeOdp(), 'd.odp')
    const clean = sanitizeObjects(deck.slides[0].objects)
    expect(clean.length).toBe(deck.slides[0].objects.length)
  })
})
