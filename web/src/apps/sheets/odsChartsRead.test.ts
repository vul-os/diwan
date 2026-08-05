import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { readOdsObjects } from './odsChartsRead.js'

// Build a structurally-valid .ods package (a ZIP) by hand. This is the real
// OpenDocument layout LibreOffice writes — a mimetype file, a META-INF/
// manifest.xml listing every part with its media-type, and content.xml — so the
// detector is exercised against a genuine ODS structure (we just don't have
// LibreOffice to generate one, so we assemble the spec-accurate bytes ourselves).
async function buildOds({ charts = 0, pivots = 0 }: { charts?: number; pivots?: number } = {}): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet')

  const entries = [
    '<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>',
    '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>',
  ]
  for (let i = 1; i <= charts; i++) {
    // A chart object: a directory entry with the chart media-type, plus its own
    // content.xml (text/xml) and a PNG replacement preview (image/png) — exactly
    // as LibreOffice writes them. Only the directory entry carries the chart mime.
    entries.push(`<manifest:file-entry manifest:full-path="Object ${i}/" manifest:media-type="application/vnd.oasis.opendocument.chart"/>`)
    entries.push(`<manifest:file-entry manifest:full-path="Object ${i}/content.xml" manifest:media-type="text/xml"/>`)
    entries.push(`<manifest:file-entry manifest:full-path="ObjectReplacements/Object ${i}" manifest:media-type="image/png"/>`)
    zip.file(`Object ${i}/content.xml`, '<?xml version="1.0"?><office:document-content><chart:chart/></office:document-content>')
  }
  zip.file('META-INF/manifest.xml',
    `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">${entries.join('')}</manifest:manifest>`)

  // content.xml with `pivots` DataPilot tables.
  const pilots = Array.from({ length: pivots }, (_, i) =>
    `<table:data-pilot-table table:name="Pilot${i}"><table:source-cell-range/></table:data-pilot-table>`).join('')
  zip.file('content.xml',
    `<?xml version="1.0"?><office:document-content xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"><office:body><office:spreadsheet><table:table table:name="Sheet1"/><table:data-pilot-tables>${pilots}</table:data-pilot-tables></office:spreadsheet></office:body></office:document-content>`)

  return zip.generateAsync({ type: 'arraybuffer' })
}

describe('readOdsObjects (.ods chart/pivot detection)', () => {
  it('counts embedded charts from the manifest chart media-type entries', async () => {
    const buf = await buildOds({ charts: 3 })
    const found = await readOdsObjects(buf)
    expect(found.charts).toBe(3)
    expect(found.pivots).toBe(0)
  })

  it('counts DataPilot (pivot) tables in content.xml', async () => {
    const buf = await buildOds({ pivots: 2 })
    const found = await readOdsObjects(buf)
    expect(found.pivots).toBe(2)
    expect(found.charts).toBe(0)
  })

  it('counts charts AND pivots together', async () => {
    const buf = await buildOds({ charts: 1, pivots: 1 })
    expect(await readOdsObjects(buf)).toEqual({ charts: 1, pivots: 1 })
  })

  it('reports nothing for a clean .ods (no charts, no pivots)', async () => {
    const buf = await buildOds({})
    expect(await readOdsObjects(buf)).toEqual({ charts: 0, pivots: 0 })
  })

  it('never throws on a non-zip / corrupt buffer', async () => {
    const found = await readOdsObjects(new Uint8Array([1, 2, 3, 4]).buffer)
    expect(found).toEqual({ charts: 0, pivots: 0 })
  })
})
