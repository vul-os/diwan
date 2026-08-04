/**
 * xlsxCharts.test.js  (WAVE-64)
 *
 * The .xlsx export used to DROP every chart into a side data sheet and say
 * nothing. It now writes REAL OOXML chart parts into the package SheetJS
 * produced. These tests pin that contract end to end:
 *
 *   - every chart type emits a chart part of the right OOXML kind, with SERIES
 *     THAT POINT AT CELLS (so Excel recalculates them);
 *   - the injected package is still a valid workbook (SheetJS re-reads it, the
 *     cells are intact, the rels/content-types/drawing are wired);
 *   - untrusted cell text cannot break out of the XML or ride in as a formula;
 *   - injection is FAIL-CLOSED: an unexpected package shape returns the original
 *     buffer with every chart reported as skipped, rather than a corrupt file.
 *
 * (Cross-checked out of band against openpyxl — an independent OOXML reader —
 * which parses all 14 parts back with the right chart classes, groupings and
 * series references.)
 */
import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import JSZip from 'jszip'
import {
  chartPartXml, drawingXml, chartRefs, absRef, xmlEscape, nativeXlsxSupport,
  injectChartsIntoXlsx,
} from './xlsxCharts.js'
import { makeChart, type Chart, type ChartInput } from './charts.js'
import { fortuneToWorksheet } from './sheetsExport.js'

const GRID: (string | number)[][] = [
  ['Quarter', 'Revenue', 'Cost', 'Margin'],
  ['Q1', 100, 60, 12],
  ['Q2', 140, 70, 18],
  ['Q3', 90, 80, 9],
  ['Q4', 200, 110, 25],
]

function sheetFrom(grid: (string | number)[][] = GRID, charts: Chart[] = []) {
  const celldata: { r: number; c: number; v: { v: string | number; m: string; ct: { fa: string; t: string } } }[] = []
  grid.forEach((row, r) => row.forEach((v, c) => {
    if (v === '' || v == null) return
    const isNum = typeof v === 'number'
    celldata.push({ r, c, v: { v, m: String(v), ct: { fa: 'General', t: isNum ? 'n' : 's' } } })
  }))
  return { name: 'Sheet1', celldata, config: {}, charts }
}

function chart(type: string, over: ChartInput = {}): Chart {
  return makeChart({
    id: 'c_' + type, type, range: 'A1:D5', title: `${type} chart`,
    options: { headerRow: true, headerCol: true, legend: true, ...(over.options || {}) },
    ...over,
  })
}

async function xlsxWith(charts: Chart[]) {
  const sheet = sheetFrom(GRID, charts)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, fortuneToWorksheet(sheet), 'Sheet1')
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
  const res = await injectChartsIntoXlsx(buf, charts, sheet)
  return { ...res, zip: await JSZip.loadAsync(res.buffer) }
}

describe('nativeXlsxSupport — the honesty predicate', () => {
  it('reports every shipped chart type as embeddable', () => {
    for (const t of ['column', 'bar', 'column-stacked', 'bar-stacked', 'column-100', 'bar-100',
      'line', 'area', 'combo', 'pie', 'donut', 'scatter', 'bubble', 'histogram']) {
      expect(nativeXlsxSupport(t).native).toBe(true)
    }
  })
  it('flags the histogram caveat (fixed bins) instead of pretending it recalculates', () => {
    expect(nativeXlsxSupport('histogram').note).toMatch(/fixed values/i)
  })
  it('rejects an unknown/hostile type', () => {
    for (const t of ['__proto__', 'evil', '', undefined, null]) {
      expect(nativeXlsxSupport(t).native).toBe(false)
    }
  })
})

describe('chartRefs — range → live cell references', () => {
  it('maps series to columns and categories to the label column', () => {
    const refs = chartRefs(chart('column'), 'Sheet1')!
    expect(refs.series).toHaveLength(3)                       // B, C, D
    expect(refs.catRef).toBe("'Sheet1'!$A$2:$A$5")
    expect(refs.series[0].valRef).toBe("'Sheet1'!$B$2:$B$5")
    expect(refs.series[0].nameRef).toBe("'Sheet1'!$B$1")
  })
  it('quotes the sheet name (doubling apostrophes) and escapes XML metacharacters', () => {
    // A1 rule: 'O''Brien'. `&` and `<` must not break the XML; `'` is legal text.
    expect(absRef("O'Brien & <Co>", 1, 1, 1, 3)).toBe("'O''Brien &amp; &lt;Co&gt;'!$B$2:$B$4")
  })

  // An unparseable range falls back to the SAME default the on-screen renderer
  // uses (parseRange's A1:Z100), so the exported chart shows what the user sees —
  // an export must not quietly disagree with the live chart it came from.
  it('falls back to the renderer default for an unparseable range (parity, not divergence)', () => {
    const refs = chartRefs(makeChart({ range: 'not-a-range' }), 'S')!
    expect(refs.catRef).toBe("'S'!$A$2:$A$100")
    expect(refs.series[0].valRef).toBe("'S'!$B$2:$B$100")
  })
})

describe('chartPartXml — one part per chart type', () => {
  const cases: [string, RegExp][] = [
    ['column',          /<c:barChart>.*<c:barDir val="col"\/>.*<c:grouping val="clustered"\/>/s],
    ['bar',             /<c:barDir val="bar"\/>.*<c:grouping val="clustered"\/>/s],
    ['column-stacked',  /<c:barDir val="col"\/>.*<c:grouping val="stacked"\/>.*<c:overlap val="100"\/>/s],
    ['bar-stacked',     /<c:barDir val="bar"\/>.*<c:grouping val="stacked"\/>/s],
    ['column-100',      /<c:grouping val="percentStacked"\/>/],
    ['bar-100',         /<c:barDir val="bar"\/>.*<c:grouping val="percentStacked"\/>/s],
    ['line',            /<c:lineChart>/],
    ['area',            /<c:areaChart>/],
    ['pie',             /<c:pieChart>/],
    ['donut',           /<c:doughnutChart>.*<c:holeSize val="55"\/>/s],
  ]
  for (const [type, re] of cases) {
    it(`emits a ${type} chart part`, () => {
      const xml = chartPartXml(chart(type), sheetFrom(), 'Sheet1')!
      expect(xml).toMatch(re)
      expect(xml).toContain('<c:chartSpace')
      expect(xml).toContain("'Sheet1'!$B$2:$B$5")            // live cell reference
      expect(xml).toContain(`${type} chart`)                  // title
    })
  }

  it('100% stacked labels its value axis as a percentage', () => {
    expect(chartPartXml(chart('column-100'), sheetFrom(), 'Sheet1'))
      .toContain('<c:numFmt formatCode="0%"')
  })

  it('scatter emits xVal/yVal (not cat/val)', () => {
    const xml = chartPartXml(chart('scatter', { range: 'B1:C5', options: { headerCol: false } }), sheetFrom(), 'Sheet1')!
    expect(xml).toContain('<c:scatterChart>')
    expect(xml).toContain('<c:xVal>')
    expect(xml).toContain('<c:yVal>')
  })

  it('bubble emits a bubbleSize series — and refuses to invent one when absent', () => {
    const ok = chartPartXml(chart('bubble', { range: 'B1:D5', options: { headerCol: false } }), sheetFrom(), 'Sheet1')!
    expect(ok).toContain('<c:bubbleSize>')
    // Only two numeric columns → no size column → we do NOT fabricate one.
    const missing = chartPartXml(chart('bubble', { range: 'B1:C5', options: { headerCol: false } }), sheetFrom(), 'Sheet1')
    expect(missing).toBeNull()
  })

  it('combo emits a barChart AND a lineChart, with a secondary axis when asked', () => {
    const plain = chartPartXml(chart('combo'), sheetFrom(), 'Sheet1')!
    expect(plain).toContain('<c:barChart>')
    expect(plain).toContain('<c:lineChart>')
    expect(plain).not.toContain('<c:axId val="40"/>')          // single axis pair

    const secondary = chartPartXml(
      chart('combo', { options: { headerRow: true, headerCol: true, secondaryAxis: true, y2AxisLabel: 'Margin' } }),
      sheetFrom(), 'Sheet1'
    )!
    // The line group is bound to the second axis pair, whose value axis sits on
    // the right and crosses the (hidden) category axis at its maximum.
    expect(secondary).toMatch(/<c:lineChart>.*<c:axId val="30"\/><c:axId val="40"\/>.*<\/c:lineChart>/s)
    expect(secondary).toContain('<c:axPos val="r"/>')
    expect(secondary).toContain('<c:crosses val="max"/>')
    expect(secondary).toContain('Margin')
  })

  it('histogram embeds the computed BINS as literal values (Excel has no re-binning)', () => {
    const xml = chartPartXml(
      chart('histogram', { range: 'B1:B5', options: { headerRow: true, headerCol: false, bins: 2 } }),
      sheetFrom(), 'Sheet1'
    )!
    expect(xml).toContain('<c:barChart>')
    expect(xml).toContain('<c:gapWidth val="0"/>')             // adjacent bars = distribution
    expect(xml).toContain('<c:numLit>')                        // counts, not a cell ref
    expect(xml).toContain('<c:strLit>')                        // bin labels
    expect(xml).not.toContain('<c:numRef>')
  })

  it('honours legend:false', () => {
    const off = chartPartXml(chart('column', { options: { legend: false, headerRow: true, headerCol: true } }), sheetFrom(), 'Sheet1')
    expect(off).not.toContain('<c:legend>')
    expect(chartPartXml(chart('column'), sheetFrom(), 'Sheet1')).toContain('<c:legend>')
  })

  it('returns null (never a half-built part) for an unsupported type', () => {
    expect(chartPartXml({ type: 'evil', range: 'A1:B2', options: {} } as unknown as Chart, sheetFrom(), 'S')).toBeNull()
    expect(chartPartXml({ type: '__proto__', range: 'A1:B2', options: {} } as unknown as Chart, sheetFrom(), 'S')).toBeNull()
  })
})

describe('XML injection safety (untrusted cell/peer text)', () => {
  it('escapes markup and neutralises a formula-triggering title', () => {
    const hostile = makeChart({
      type: 'column', range: 'A1:D5',
      title: '</c:t></a:t><script>alert(1)</script>',
      options: { xAxisLabel: '=HYPERLINK("http://evil")', headerRow: true, headerCol: true },
    })
    const xml = chartPartXml(hostile, sheetFrom(), 'Sheet1')!
    // No raw tag survives: every < > & " ' is entity-encoded.
    expect(xml).not.toContain('<script>')
    expect(xml).not.toContain('</c:t></a:t>')
    expect(xml).toContain('&lt;script&gt;')
    // The formula trigger is quoted by escapeChartText BEFORE it is XML-escaped,
    // so even a reader that un-escapes the text gets a literal, not a formula.
    expect(xml).toContain("&apos;=HYPERLINK")
    // …and the part is still well-formed XML.
    expect(() => new DOMParser().parseFromString(xml, 'application/xml')).not.toThrow()
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    expect(doc.querySelector('parsererror')).toBeNull()
  })

  it('xmlEscape covers every metacharacter', () => {
    expect(xmlEscape(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&apos;')
  })
})

describe('injectChartsIntoXlsx — package surgery', () => {
  it('writes chart parts, a drawing, rels and content types — and the workbook still reads', async () => {
    const charts = [chart('column'), chart('donut'), chart('line')]
    const { zip, embedded, skipped, buffer } = await xlsxWith(charts)
    expect(embedded).toHaveLength(3)
    expect(skipped).toHaveLength(0)

    const names = Object.keys(zip.files)
    expect(names).toContain('xl/charts/chart1.xml')
    expect(names).toContain('xl/charts/chart3.xml')
    expect(names).toContain('xl/drawings/drawing1.xml')
    expect(names).toContain('xl/drawings/_rels/drawing1.xml.rels')
    expect(names).toContain('xl/worksheets/_rels/sheet1.xml.rels')

    // Content types declare the new parts (Excel refuses the file otherwise).
    const ct = await zip.file('[Content_Types].xml')!.async('string')
    expect(ct).toContain('/xl/charts/chart1.xml')
    expect(ct).toContain('drawingml.chart+xml')
    expect(ct).toContain('/xl/drawings/drawing1.xml')

    // The worksheet points at the drawing, which points at the charts.
    const ws = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
    expect(ws).toMatch(/<drawing r:id="rId\d+"\/>\s*<\/worksheet>/)
    const drels = await zip.file('xl/drawings/_rels/drawing1.xml.rels')!.async('string')
    expect(drels).toContain('../charts/chart1.xml')
    expect(drels).toContain('../charts/chart3.xml')

    // PACKAGE INTEGRITY: SheetJS can still parse the workbook and its cells.
    const back = XLSX.read(buffer, { type: 'array' })
    expect(back.SheetNames).toContain('Sheet1')
    expect(back.Sheets.Sheet1.B2.v).toBe(100)
    expect(back.Sheets.Sheet1.A1.v).toBe('Quarter')
  })

  it('anchors each chart at its saved position/size', async () => {
    const c = chart('column', { x: 640, y: 200, w: 480, h: 300 })
    const { zip } = await xlsxWith([c])
    const d = await zip.file('xl/drawings/drawing1.xml')!.async('string')
    expect(d).toContain('<xdr:col>10</xdr:col>')     // 640px / 64px per col
    expect(d).toContain('<xdr:row>10</xdr:row>')     // 200px / 20px per row
    expect(d).toContain('cx="4572000"')              // 480px * 9525 EMU
    expect(d).toContain('cy="2857500"')              // 300px * 9525 EMU
  })

  it('SKIPS (and reports) a chart it cannot express — never a corrupt part', async () => {
    const bad = { id: 'x', type: 'evil', range: 'A1:D5', options: {}, x: 0, y: 0, w: 480, h: 300 } as unknown as Chart
    const { embedded, skipped, zip } = await xlsxWith([chart('column'), bad])
    expect(embedded).toEqual(['c_column'])
    expect(skipped).toEqual([{ id: 'x', type: 'evil', reason: 'no Excel equivalent' }])
    expect(Object.keys(zip.files)).not.toContain('xl/charts/chart2.xml')
  })

  it('does nothing at all when there are no charts', async () => {
    const buf = XLSX.write((() => {
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, fortuneToWorksheet(sheetFrom()), 'Sheet1')
      return wb
    })(), { bookType: 'xlsx', type: 'array' })
    const res = await injectChartsIntoXlsx(buf, [], sheetFrom())
    expect(res.embedded).toEqual([])
    expect(res.skipped).toEqual([])
    expect(res.buffer).toBe(buf)                     // untouched original
  })

  it('FAILS CLOSED on an unreadable package: original buffer, everything reported skipped', async () => {
    const junk = new Uint8Array([1, 2, 3, 4]).buffer
    const res = await injectChartsIntoXlsx(junk, [chart('column')], sheetFrom())
    expect(res.buffer).toBe(junk)                    // we never hand back a mangled file
    expect(res.embedded).toEqual([])
    expect(res.skipped[0].reason).toMatch(/could not be re-opened/i)
  })

  it('FAILS CLOSED when the package already carries drawings (shape we do not understand)', async () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, fortuneToWorksheet(sheetFrom()), 'Sheet1')
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
    const zip = await JSZip.loadAsync(buf)
    zip.file('xl/drawings/drawing1.xml', '<xdr:wsDr/>')
    const withDrawing = await zip.generateAsync({ type: 'arraybuffer' })
    const res = await injectChartsIntoXlsx(withDrawing, [chart('column')], sheetFrom())
    expect(res.embedded).toEqual([])
    expect(res.skipped[0].reason).toMatch(/already contains drawings/i)
  })
})

describe('drawingXml', () => {
  it('clamps a hostile/absurd geometry — a NaN extent would make Excel reject the file', () => {
    const xml = drawingXml([{ rId: 'rId1', x: -50, y: NaN, w: 0, h: NaN }])
    expect(xml).not.toContain('NaN')
    expect(xml).toContain('<xdr:col>0</xdr:col>')
    expect(xml).toContain('<xdr:row>0</xdr:row>')
    expect(xml).toContain('cx="4572000"')   // 0/NaN size → the 480×300 default
    expect(xml).toContain('cy="2857500"')

    const huge = drawingXml([{ rId: 'rId1', x: 1e12, y: 1e12, w: 1e9, h: 1e9 }])
    expect(huge).toContain('cx="38100000"')  // clamped to 4000px
    expect(huge).toContain('cy="38100000"')
  })
})
