/**
 * chartsExport.test.js (WAVE-54, rewritten WAVE-64)
 *
 * Export fidelity for charts. WAVE-64 changed the contract in two ways and both
 * halves are pinned here:
 *
 *   1. .xlsx now embeds REAL OOXML charts (see xlsxCharts.test.js), and the
 *      "Vulos Charts" definition sheet became a LOSSLESS ROUND-TRIP carrier —
 *      exporting and re-importing restores every chart exactly (type, range,
 *      options, position, size), instead of leaving the user with a stray sheet
 *      of rows and no charts.
 *   2. Nothing is lost SILENTLY: exportFidelity reports, per format, what will
 *      be embedded, what is degraded and what cannot survive at all — the data
 *      behind the export dialog.
 */
import { describe, it, expect, vi } from 'vitest'
import * as XLSX from 'xlsx'
import {
  chartsMetaSheet, exportFidelity, exportNeedsConfirm, exportSheetsToXlsx, CHART_META_SHEET,
  type ExportSheet,
} from './sheetsExport.js'
import { workbookToSheets } from './sheetsImport.js'
import { insertChart, getCharts, makeChart, type ChartSheet } from './charts.js'
import { insertPivot, type PivotSheet } from './pivot.js'

// file-saver is the only side effect in the export path; capture the Blob it is
// handed so a test can read back the EXACT bytes a user would download.
const saved: { blob: Blob; name: string }[] = []
vi.mock('file-saver', () => ({
  saveAs: (blob: Blob, name: string) => { saved.push({ blob, name }) },
}))

// charts.ts / sheetsExport.ts / sheetsImport.ts / pivot.ts each declare their
// own narrow view of the SAME plain-data FortuneSheet shape (ChartSheet /
// ExportSheet / ImportSheet / PivotSheet) — no shared base type. Production
// crosses these boundaries with the same cast-through-unknown helper
// (SheetsEditor.tsx's `cast<T>`).
function cast<T>(v: unknown): T { return v as T }

function wb(cells: Record<string, string | number> = {}): ChartSheet[] {
  const celldata = Object.entries(cells).map(([k, v]) => {
    const [r, c] = k.split('_').map(Number)
    return { r, c, v: { v, m: String(v), ct: { fa: 'General', t: typeof v === 'number' ? 'n' : 's' } } }
  })
  return [{ name: 'Sheet1', celldata, config: {} }]
}

const DATA_CELLS = {
  '0_0': 'Quarter', '0_1': 'Revenue', '0_2': 'Cost',
  '1_0': 'Q1', '1_1': 100, '1_2': 60,
  '2_0': 'Q2', '2_1': 140, '2_2': 70,
  '3_0': 'Q3', '3_1': 90,  '3_2': 80,
}

describe('chart export metadata', () => {
  it('returns null when there are no charts (no stray sheet emitted)', () => {
    expect(chartsMetaSheet(cast<ExportSheet[]>(wb()))).toBeNull()
  })

  it('serialises the FULL chart definition — including the fields that used to be dropped', () => {
    let data = insertChart(wb(), { id: 'c1', type: 'column', range: 'A1:B3', title: 'Rev', options: { legend: false, headerRow: true, headerCol: true } })
    data = insertChart(data, { id: 'c2', type: 'pie', range: 'D1:E4', title: 'Split' })
    const ws = chartsMetaSheet(cast<ExportSheet[]>(data))
    expect(ws).toBeTruthy()
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws!, { header: 1 })
    expect(rows[0]).toEqual([
      'type', 'range', 'title', 'xAxisLabel', 'yAxisLabel', 'legend', 'headerRow', 'headerCol',
      'y2AxisLabel', 'secondaryAxis', 'bins', 'x', 'y', 'w', 'h', 'id',
    ])
    expect(rows[1][0]).toBe('column')
    expect(rows[1][1]).toBe('A1:B3')
    expect(rows[1][2]).toBe('Rev')
    expect(rows[1][5]).toBe('no')   // legend:false
    expect(rows[2][0]).toBe('pie')
    expect(rows[2][2]).toBe('Split')
    // WAVE-64: geometry + id now ride along, which is what makes import lossless.
    expect(rows[1][11]).toBe(40)    // x (makeChart default)
    expect(rows[1][15]).toBe('c1')  // id
  })

  // WAVE-55 regression: a chart title/label containing a leading formula trigger
  // (from cell data or a hostile peer) must be neutralised before it is written
  // into the exported worksheet, or Excel would evaluate it as a live formula
  // (CSV/formula injection). escapeChartText prefixes a quote.
  it('neutralises formula-injection in exported title / axis labels', () => {
    const data = insertChart(wb(), {
      id: 'c1', type: 'column', range: 'A1:B3',
      title: '=HYPERLINK("http://evil","click")',
      options: { xAxisLabel: '+SUM(1)', yAxisLabel: '@cmd', legend: true, headerRow: true, headerCol: true },
    })
    const ws = chartsMetaSheet(cast<ExportSheet[]>(data))
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws!, { header: 1 })
    // Every free-text field is quoted so it renders as a literal glyph, not a formula.
    expect((rows[1][2] as string).startsWith("'=")).toBe(true)   // title
    expect((rows[1][3] as string).startsWith("'+")).toBe(true)   // xAxisLabel
    expect((rows[1][4] as string).startsWith("'@")).toBe(true)   // yAxisLabel
    // And the raw formula string is NOT present verbatim as a leading-= cell.
    expect((rows[1][2] as string).startsWith('=')).toBe(false)
  })
})

/**
 * THE ROUND TRIP — the recoverability half of the data-loss fix.
 * Export the workbook the way the app does (real file bytes), then import those
 * bytes back through the real importer, and assert the charts came back.
 */
describe('xlsx chart ROUND TRIP (export → import restores the charts)', () => {
  async function roundTrip(data: ChartSheet[]) {
    saved.length = 0
    await exportSheetsToXlsx(cast<ExportSheet[]>(data), 'book')
    expect(saved).toHaveLength(1)
    const buf = await saved[0].blob.arrayBuffer()
    return { sheets: cast<ChartSheet[]>(workbookToSheets(buf, 'book.xlsx')), buf }
  }

  it('restores every chart exactly — type, range, title, options, position, size', async () => {
    const charts = [
      { id: 'c1', type: 'column-stacked', range: 'A1:C4', title: 'Stacked revenue',
        options: { xAxisLabel: 'Quarter', yAxisLabel: 'USD', legend: false, headerRow: true, headerCol: true },
        x: 320, y: 120, w: 600, h: 380 },
      { id: 'c2', type: 'combo', range: 'A1:C4', title: 'Rev vs cost',
        options: { secondaryAxis: true, y2AxisLabel: 'Cost', headerRow: true, headerCol: true },
        x: 40, y: 500, w: 480, h: 300 },
      { id: 'c3', type: 'histogram', range: 'B1:B4', title: 'Spread',
        options: { bins: 7, headerRow: true, headerCol: false }, x: 900, y: 60, w: 500, h: 320 },
      { id: 'c4', type: 'donut', range: 'A1:B4', title: 'Share', options: { headerRow: true, headerCol: true } },
    ]
    let data = wb(DATA_CELLS)
    for (const c of charts) data = insertChart(data, c)
    const original = getCharts(data)

    const { sheets } = await roundTrip(data)
    const restored = getCharts(sheets)

    expect(restored).toHaveLength(4)
    // Deep equality against the pre-export descriptors: nothing lost, nothing invented.
    expect(restored).toEqual(original)
  })

  // Regression: `x`/`y` may legitimately be 0 (a chart dragged flush to the grid
  // origin). A truthiness/`> 0` test on import would silently relocate it to
  // makeChart's default 40,40 — a chart that MOVES on round-trip is still a
  // round-trip bug.
  it('restores a chart anchored at the grid origin (x=0, y=0) without moving it', async () => {
    const data = insertChart(wb(DATA_CELLS), {
      id: 'c0', type: 'column', range: 'A1:C4', title: 'Origin', x: 0, y: 0, w: 480, h: 300,
    })
    const { sheets } = await roundTrip(data)
    const [c] = getCharts(sheets)
    expect(c.x).toBe(0)
    expect(c.y).toBe(0)
    expect(c.w).toBe(480)
  })

  it('does not leave the definition sheet lying around as a worksheet', async () => {
    const data = insertChart(wb(DATA_CELLS), { id: 'c1', type: 'column', range: 'A1:C4', title: 'Rev' })
    const { sheets, buf } = await roundTrip(data)
    // The sheet IS in the file (it is the carrier)…
    expect(XLSX.read(buf, { type: 'array' }).SheetNames).toContain(CHART_META_SHEET)
    // …but it comes back as CHARTS, not as a stray sheet of rows.
    expect(sheets.map((s) => s.name)).toEqual(['Sheet1'])
    expect(getCharts(sheets)).toHaveLength(1)
  })

  it('the exported file also carries REAL Excel chart parts (not just the definitions)', async () => {
    const data = insertChart(wb(DATA_CELLS), { id: 'c1', type: 'column', range: 'A1:C4', title: 'Rev' })
    const { buf } = await roundTrip(data)
    const JSZip = (await import('jszip')).default
    const zip = await JSZip.loadAsync(buf)
    expect(Object.keys(zip.files)).toContain('xl/charts/chart1.xml')
    const chartXml = await zip.file('xl/charts/chart1.xml')!.async('string')
    expect(chartXml).toContain('<c:barChart>')
    expect(chartXml).toContain("'Sheet1'!$B$2:$B$4")   // live, recalculating reference
  })

  it('a corrupt/hostile definition sheet cannot smuggle a bad chart back in (import clamp)', () => {
    const meta = XLSX.utils.aoa_to_sheet([
      ['type', 'range', 'title', 'xAxisLabel', 'yAxisLabel', 'legend', 'headerRow', 'headerCol',
        'y2AxisLabel', 'secondaryAxis', 'bins', 'x', 'y', 'w', 'h', 'id'],
      ['__proto__', 'A1:B3', 'x', '', '', 'yes', 'yes', 'yes', '', 'yes', 9999, -5, 1e12, 1e9, 'NaN', 'evil'],
    ])
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['A'], [1]]), 'Sheet1')
    XLSX.utils.book_append_sheet(book, meta, CHART_META_SHEET)
    const buf = XLSX.write(book, { bookType: 'xlsx', type: 'array' })

    const sheets = workbookToSheets(buf, 'hostile.xlsx')
    const [c] = getCharts(cast<ChartSheet[]>(sheets))
    expect(c.type).toBe('column')                     // unknown type → clamped default
    expect(c.options.bins).toBeLessThanOrEqual(50)    // bin count clamped
    expect(Number.isFinite(c.x) && Number.isFinite(c.y)).toBe(true)
    expect(c.w).toBeLessThanOrEqual(4000)
    expect(c.h).toBeGreaterThanOrEqual(120)           // NaN height → clamped default
    expect(JSON.parse(JSON.stringify(c))).toEqual(c)  // plain, serialisable data
  })

  it('ignores a "Vulos Charts"-named sheet that is not ours (schema check)', () => {
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['A'], [1]]), 'Sheet1')
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['hello', 'world'], [1, 2]]), CHART_META_SHEET)
    const buf = XLSX.write(book, { bookType: 'xlsx', type: 'array' })
    const sheets = workbookToSheets(buf, 'other.xlsx')
    expect(getCharts(cast<ChartSheet[]>(sheets))).toHaveLength(0)
    // Not our schema → it stays a normal worksheet rather than vanishing.
    expect(sheets.map((s) => s.name)).toEqual(['Sheet1', CHART_META_SHEET])
  })
})

describe('exportFidelity — the user gets told BEFORE anything is lost', () => {
  const withCharts = (): ExportSheet[] => {
    let d = insertChart(wb(DATA_CELLS), { id: 'c1', type: 'column', range: 'A1:C4', title: 'Rev' })
    d = insertChart(d, { id: 'c2', type: 'histogram', range: 'B1:B4', title: 'Spread' })
    return cast<ExportSheet[]>(d)
  }

  it('xlsx: charts embed natively; the histogram declares its caveat', () => {
    const r = exportFidelity(withCharts(), 'xlsx')
    expect(r.charts).toBe(2)
    expect(r.native).toBe(2)
    expect(r.lost).toHaveLength(0)
    expect(r.degraded).toHaveLength(1)
    expect(r.degraded[0].type).toBe('histogram')
    expect(r.degraded[0].note).toMatch(/fixed values/i)
    expect(r.notes.join(' ')).toMatch(/real Excel charts/i)
  })

  it('ods: charts CANNOT be embedded — every one is reported as a loss, with the recovery path', () => {
    const r = exportFidelity(withCharts(), 'ods')
    expect(r.lost).toHaveLength(2)
    expect(r.lost.every((l) => /cannot embed/i.test(l.note))).toBe(true)
    expect(r.notes.join(' ')).toMatch(/data sheet/i)
    expect(r.notes.join(' ')).toMatch(/restores them/i)
  })

  it('csv: charts are dropped and it says so', () => {
    const r = exportFidelity(withCharts(), 'csv')
    expect(r.lost).toHaveLength(2)
    expect(r.notes.join(' ')).toMatch(/CSV holds values only/i)
  })

  it('an unsupported chart type is reported as LOST, not silently swallowed', () => {
    const data = [{ ...wb(DATA_CELLS)[0], charts: [{ id: 'x', type: 'evil', range: 'A1:B2', options: {} }] }]
    const r = exportFidelity(cast<ExportSheet[]>(data), 'xlsx')
    expect(r.native).toBe(0)
    expect(r.lost).toHaveLength(1)
    expect(r.lost[0].note).toMatch(/no Excel equivalent/i)
  })

  it('live pivots are reported as not-exported, with the workaround', () => {
    const data = insertPivot(cast<PivotSheet[]>(wb(DATA_CELLS)), { range: 'A1:C4', rowField: 'Quarter', valueField: 'Revenue' })
    const r = exportFidelity(cast<ExportSheet[]>(data), 'xlsx')
    expect(r.pivots).toBe(1)
    expect(r.notes.join(' ')).toMatch(/not exported/i)
    expect(r.notes.join(' ')).toMatch(/static sheet/i)
  })

  // The Go server exporter has no chart writer, and it is reachable from the SAME
  // Export menu — so it must warn like every other lossy path, not drop quietly.
  it('xlsx-server: says the server path writes cells only, and points at the lossless one', () => {
    const r = exportFidelity(withCharts(), 'xlsx-server')
    expect(r.lost).toHaveLength(2)
    expect(r.lost[0].note).toMatch(/cells only/i)
    expect(r.notes.join(' ')).toMatch(/Excel workbook.*instead.*keep your charts/i)
    expect(r.notes.join(' ')).toMatch(/LAST SAVED/i)
  })

  it('exportNeedsConfirm: silent for a plain workbook, but never when something is at stake', () => {
    expect(exportNeedsConfirm(cast<ExportSheet[]>(wb(DATA_CELLS)), 'xlsx')).toBe(false)   // nothing to say → no friction
    expect(exportNeedsConfirm(cast<ExportSheet[]>(wb(DATA_CELLS)), 'csv')).toBe(false)
    expect(exportNeedsConfirm(withCharts(), 'xlsx')).toBe(true)      // histogram caveat
    expect(exportNeedsConfirm(withCharts(), 'ods')).toBe(true)       // charts cannot embed
    expect(exportNeedsConfirm(withCharts(), 'csv')).toBe(true)
    const plainChart = cast<ExportSheet[]>(insertChart(wb(DATA_CELLS), { id: 'c1', type: 'column', range: 'A1:C4' }))
    expect(exportNeedsConfirm(plainChart, 'ods')).toBe(true)         // still a loss in ods
    expect(exportNeedsConfirm(plainChart, 'xlsx-server')).toBe(true) // server path drops charts
    expect(exportNeedsConfirm(plainChart, 'xlsx')).toBe(false)       // fully embeddable
  })
})

describe('exportSheetsToXlsx — reports what it actually did', () => {
  it('returns the embedded/skipped split so the caller can tell the user', async () => {
    const data = [{
      ...wb(DATA_CELLS)[0],
      charts: [
        makeChart({ id: 'ok', type: 'column', range: 'A1:C4' }),
        { id: 'bad', type: 'evil', range: 'A1:C4', options: {}, x: 0, y: 0, w: 480, h: 300 },
      ],
    }]
    saved.length = 0
    const res = await exportSheetsToXlsx(cast<ExportSheet[]>(data), 'book')
    expect(res.embedded).toEqual(['ok'])
    expect(res.skipped).toEqual([{ id: 'bad', type: 'evil', reason: 'no Excel equivalent' }])
    expect(saved[0].name).toBe('book.xlsx')
  })
})
