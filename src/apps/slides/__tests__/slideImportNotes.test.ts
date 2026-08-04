/**
 * slideImportNotes.test.js — .pptx import HONESTY (the itemized-loss pattern).
 *
 * Neither Google Slides nor PowerPoint tells you what a lossy import dropped;
 * we do. These tests prove:
 *   1. The importNotes helpers clamp/summarise correctly.
 *   2. A .pptx carrying a table, chart, SmartArt, group, EMF image, transition,
 *      and animation timeline is IMPORTED and its losses are RECORDED on the
 *      deck (so the editor banner + export dialog can restate them) — never
 *      silently dropped.
 *   3. A clean deck records NO notes (zero-friction path preserved).
 */

import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { pptxToSlides } from '../slidesImport.js'
import {
  makeSlideImportNotes,
  hasSlideImportLoss,
  slideImportLossItems,
  slideImportLossSummary,
  getSlideImportNotes,
} from '../importNotes'

const RASTER = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

// ── Helpers module ───────────────────────────────────────────────────────────
describe('slide importNotes helpers', () => {
  it('returns null for a clean import and clamps counts', () => {
    expect(makeSlideImportNotes(null)).toBeNull()
    expect(makeSlideImportNotes({ tables: 0, charts: 0 })).toBeNull()
    const n = makeSlideImportNotes({ tables: 2, charts: -5, groups: 1.9 })
    expect(n).toEqual({ tables: 2, groups: 1 })
    expect(hasSlideImportLoss(n)).toBe(true)
  })

  it('itemises + summarises with correct pluralisation', () => {
    const n = makeSlideImportNotes({ tables: 1, charts: 3 })
    expect(slideImportLossItems(n)).toEqual(['1 table', '3 charts'])
    expect(slideImportLossSummary(n)).toMatch(/1 table, 3 charts could not be imported/)
    expect(slideImportLossSummary(null)).toBe('')
  })
})

// ── Real pptx import ─────────────────────────────────────────────────────────
function lossySlideXml() {
  return `<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
 <p:cSld><p:spTree>
  <p:sp><p:spPr><a:xfrm><a:off x="838200" y="365760"/><a:ext cx="9000000" cy="1000000"/></a:xfrm></p:spPr>
   <p:txBody><a:p><a:r><a:t>Real text box</a:t></a:r></a:p></p:txBody></p:sp>
  <p:graphicFrame><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">
    <a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>cell</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl>
  </a:graphicData></a:graphic></p:graphicFrame>
  <p:graphicFrame><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
    <c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId9"/>
  </a:graphicData></a:graphic></p:graphicFrame>
  <p:graphicFrame><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"/></a:graphic></p:graphicFrame>
  <p:grpSp><p:nvGrpSpPr/></p:grpSp>
  <p:pic><p:blipFill><a:blip r:embed="rId3"/></p:blipFill>
   <p:spPr><a:xfrm><a:off x="1" y="1"/><a:ext cx="1000000" cy="1000000"/></a:xfrm></p:spPr></p:pic>
 </p:spTree></p:cSld>
 <p:transition><p:fade/></p:transition>
 <p:timing><p:tnLst/></p:timing>
</p:sld>`
}

async function makeLossyPptx() {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types/>')
  zip.file('ppt/presentation.xml',
    `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
    `<p:sldSz cx="12192000" cy="6858000"/></p:presentation>`)
  zip.file('ppt/slides/slide1.xml', lossySlideXml())
  zip.file('ppt/slides/_rels/slide1.xml.rels',
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId3" Type="image" Target="../media/pic1.emf"/></Relationships>`)
  zip.file('ppt/media/pic1.emf', RASTER)
  return zip.generateAsync({ type: 'arraybuffer' })
}

describe('pptxToSlides — import honesty', () => {
  it('records tables/charts/diagrams/groups/emf/transitions/animations as losses', async () => {
    const deck = await pptxToSlides(await makeLossyPptx(), 'lossy.pptx')
    // The real text box still imported (loss accounting never blocks content).
    const objs = deck.slides[0].objects
    expect(objs.some((o) => o.type === 'text' && /Real text box/.test(o.html))).toBe(true)

    const notes = getSlideImportNotes(deck)
    expect(notes).toBeTruthy()
    expect(notes!.tables).toBe(1)
    expect(notes!.charts).toBe(1)
    expect(notes!.diagrams).toBe(1)
    expect(notes!.groups).toBe(1)
    expect(notes!.vectorImages).toBe(1)  // the .emf could not embed
    expect(notes!.transitions).toBe(1)
    expect(notes!.animations).toBe(1)
    expect(notes!.filename).toBe('lossy.pptx')

    const items = slideImportLossItems(notes)
    expect(items).toContain('1 table')
    expect(items).toContain('1 chart')
  })

  it('a clean deck records NO import notes', async () => {
    const zip = new JSZip()
    zip.file('[Content_Types].xml', '<Types/>')
    zip.file('ppt/presentation.xml',
      `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
      `<p:sldSz cx="12192000" cy="6858000"/></p:presentation>`)
    zip.file('ppt/slides/slide1.xml',
      `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ` +
      `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
      `<p:cSld><p:spTree><p:sp><p:spPr/><p:txBody><a:p><a:r><a:t>hi</a:t></a:r></a:p></p:txBody></p:sp>` +
      `</p:spTree></p:cSld></p:sld>`)
    const deck = await pptxToSlides(await zip.generateAsync({ type: 'arraybuffer' }), 'clean.pptx')
    expect(deck.importNotes).toBeUndefined()
    expect(getSlideImportNotes(deck)).toBeNull()
  })
})
