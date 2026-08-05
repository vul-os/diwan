/**
 * xlsxRoundTrip.test.js — THE round-trip contract, measured on real bytes.
 *
 * The scenario this file exists for is the most ordinary thing a person does with
 * a spreadsheet, and it used to destroy their work:
 *
 *     open someone's .xlsx  →  change one cell  →  export it back
 *
 * Before this suite, that sequence SILENTLY DROPPED EVERY CHART. Measured on the
 * foreign-charts.xlsx fixture below: 4 real charts went in, 0 came out, and
 * nothing anywhere told the user — because SheetJS (community `xlsx`, our only
 * spreadsheet engine) surfaces cells and cannot see `xl/charts/chartN.xml` at all,
 * so the charts never entered the model, and by export time there was nothing left
 * to warn about. The export dialog cheerfully reported a clean export.
 *
 * So these tests assert the round trip on the ACTUAL EXPORTED BYTES (we unzip the
 * Blob the user would download and read the OOXML back), not on an intermediate
 * object that could agree with a broken writer.
 *
 * THE FIXTURES ARE FOREIGN ON PURPOSE. They were written by openpyxl — an OOXML
 * implementation that is not ours — so they are what a real user's file looks
 * like, not a re-read of our own exporter agreeing with itself. Provenance
 * (openpyxl 3.1.5):
 *
 *   foreign-charts.xlsx      Sheet "Sales": a header row, 4 data rows, a formula
 *                            (=B2-C2), a currency number format, a merged range
 *                            (A7:C7), a custom column width — plus FOUR real
 *                            charts: clustered column (1 series), STACKED column
 *                            (2 contiguous series), line, pie. Axis titles set on
 *                            the column chart.
 *   foreign-unreadable.xlsx  A radar chart (no Vulos equivalent) and a column
 *                            chart whose series come from NON-ADJACENT columns
 *                            (B and D) — two shapes our single-contiguous-range
 *                            descriptor genuinely cannot express.
 *   foreign-pivot.xlsx       A genuine pivot table (xl/pivotTables/pivotTable1.xml
 *                            + pivotCache, validated by openpyxl's own pivot
 *                            reader: PivotTable1, ref A1:B4, dataField "Sum of
 *                            Amount"), with the pivot's output rendered into real
 *                            cells the way Excel writes it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { importWorkbook, workbookToSheets, type ImportCellEntry, type ImportCellValue } from '../sheetsImport.js'
import { exportSheetsToXlsx, exportFidelity, exportNeedsConfirm, type ExportSheet } from '../sheetsExport.js'
import { getImportNotes, type INSheet } from '../importNotes.js'

// charts.ts / sheetsExport.ts / sheetsImport.ts each declare their own narrow
// view of the same plain-data FortuneSheet shape (ChartSheet / ExportSheet /
// ImportSheet) — no shared base type. Production crosses these boundaries with
// the same cast-through-unknown helper (SheetsEditor.tsx's `cast<T>`).
function cast<T>(v: unknown): T { return v as T }

// file-saver is the only side effect of the export path; capture the Blob so a
// test can read the EXACT bytes a user would have downloaded.
const saved: { blob: Blob; name: string }[] = []
vi.mock('file-saver', () => ({ saveAs: (blob: Blob, name: string) => { saved.push({ blob, name }) } }))

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

/**
 * Load a fixture as bytes allocated IN THIS REALM. A Node Buffer's backing
 * ArrayBuffer is not recognised by SheetJS/JSZip under jsdom and parses as junk —
 * a test that skipped this copy would "measure" nonsense and report a bug that
 * isn't there (it did, once).
 */
function fixture(name: string) {
  const buf = fs.readFileSync(path.join(FIXTURES, name))
  const bytes = new Uint8Array(buf.byteLength)
  bytes.set(buf)
  return bytes
}

/** The parts of the .xlsx package the last export actually wrote. */
async function exportedParts(): Promise<string[]> {
  const zip = await JSZip.loadAsync(await saved[saved.length - 1].blob.arrayBuffer())
  return Object.keys(zip.files)
}
async function exportedPart(name: string): Promise<string | undefined> {
  const zip = await JSZip.loadAsync(await saved[saved.length - 1].blob.arrayBuffer())
  return zip.file(name)?.async('string')
}

const cellAt = (sheet: { celldata: ImportCellEntry[] }, r: number, c: number): ImportCellValue | undefined =>
  sheet.celldata.find((x) => x.r === r && x.c === c)?.v

beforeEach(() => { saved.length = 0 })

describe('foreign .xlsx with charts — open, edit, export back', () => {
  it('the fixture really does contain real OOXML charts (guard on the guard)', async () => {
    const zip = await JSZip.loadAsync(fixture('foreign-charts.xlsx'))
    const parts = Object.keys(zip.files).filter((n) => /^xl\/charts\/chart\d+\.xml$/.test(n))
    expect(parts).toHaveLength(4)
  })

  it('IMPORTS the charts that used to be silently dropped', async () => {
    const { sheets } = await importWorkbook(fixture('foreign-charts.xlsx').buffer, 'foreign-charts.xlsx')
    const charts = sheets[0].charts || []

    // Before the fix this was []. Four charts in the file, four in the model.
    expect(charts).toHaveLength(4)
    expect(charts.map((c) => c.type).sort()).toEqual(['column', 'column-stacked', 'line', 'pie'])

    expect(charts.find((c) => c.type === 'line')!.title).toBe('Revenue and cost trend')
    const column = charts.find((c) => c.type === 'column')!
    expect(column.title).toBe('Revenue by quarter')
    // Header row (series names) + header column (categories) folded back into the
    // single contiguous range our renderer reads.
    expect(column.range).toBe('A1:B5')
    expect(column.options.headerRow).toBe(true)
    expect(column.options.headerCol).toBe(true)
    expect(column.options.xAxisLabel).toBe('Quarter')
    expect(column.options.yAxisLabel).toBe('ZAR')

    // Two contiguous series → one range spanning both value columns.
    expect(charts.find((c) => c.type === 'column-stacked')!.range).toBe('A1:C5')
    expect(charts.find((c) => c.type === 'line')!.range).toBe('A1:C5')

    // Geometry came from the drawing anchors, so the charts do not all land in a
    // pile at the default offset.
    const ys = charts.map((c) => c.y)
    expect(new Set(ys).size).toBeGreaterThan(1)
  })

  it('nothing else regressed: cells, formula, number format, merge, column width', async () => {
    const { sheets } = await importWorkbook(fixture('foreign-charts.xlsx').buffer, 'foreign-charts.xlsx')
    const s = sheets[0]
    expect(s.name).toBe('Sales')
    expect(cellAt(s, 0, 0)!.v).toBe('Quarter')
    expect(cellAt(s, 1, 1)!.v).toBe(100)
    expect(cellAt(s, 1, 4)!.f).toBe('=B2-C2')                    // formula, as data
    expect(cellAt(s, 1, 5)!.ct.fa).toBe('"$"#,##0.00')           // number format
    expect(s.config.merge).toEqual({ '6_0': { r: 6, c: 0, rs: 1, cs: 3 } })
    expect(s.config.columnlen![0]).toBeGreaterThan(100)
  })

  it('THE BUG: import → edit a cell → export keeps the charts as real Excel charts', async () => {
    const { sheets } = await importWorkbook(fixture('foreign-charts.xlsx').buffer, 'foreign-charts.xlsx')

    // The user changes Q1 revenue: 100 → 999.
    const edited = sheets.map((s, i) => (i !== 0 ? s : {
      ...s,
      celldata: s.celldata.map((cd) =>
        cd.r === 1 && cd.c === 1 ? { ...cd, v: { ...cd.v, v: 999, m: '999' } } : cd),
    }))

    const { embedded, skipped } = await exportSheetsToXlsx(cast<ExportSheet[]>(edited), 'out')
    expect(skipped).toEqual([])
    expect(embedded).toHaveLength(4)

    // The exported package holds four REAL chart parts (this used to be zero).
    const parts = await exportedParts()
    expect(parts.filter((n) => /^xl\/charts\/chart\d+\.xml$/.test(n))).toHaveLength(4)
    expect(parts).toContain('xl/drawings/drawing1.xml')

    // ...and the charts still point at the CELLS, so Excel recalculates them —
    // they are not baked-in pictures of the old numbers.
    const chart1 = await exportedPart('xl/charts/chart1.xml')
    expect(chart1).toContain("'Sales'!$B$2:$B$5")

    // ...and the edit is in the exported cells.
    const reread = workbookToSheets(
      await saved[0].blob.arrayBuffer().then((ab) => new Uint8Array(ab).buffer), 'out.xlsx'
    )
    expect(cellAt(reread[0], 1, 1)!.v).toBe(999)
  })

  it('the exported file re-opens in Vulos with all four charts (full circle)', async () => {
    const { sheets } = await importWorkbook(fixture('foreign-charts.xlsx').buffer, 'foreign-charts.xlsx')
    await exportSheetsToXlsx(cast<ExportSheet[]>(sheets), 'out')

    const bytes = new Uint8Array(await saved[0].blob.arrayBuffer())
    const { sheets: reopened } = await importWorkbook(bytes.buffer, 'out.xlsx')

    const charts = reopened[0].charts || []
    expect(charts).toHaveLength(4)
    expect(charts.map((c) => c.type).sort()).toEqual(['column', 'column-stacked', 'line', 'pie'])
    expect(charts.find((c) => c.type === 'column')!.title).toBe('Revenue by quarter')
    // The bookkeeping sheet must not surface as a worksheet of rows.
    expect(reopened.map((s) => s.name)).not.toContain('Vulos Charts')
  })

  it('a clean foreign import warns about nothing and exports with zero friction', async () => {
    const { sheets, notes } = await importWorkbook(fixture('foreign-charts.xlsx').buffer, 'foreign-charts.xlsx')
    expect(notes).toBeNull()
    expect(getImportNotes(cast<INSheet[]>(sheets))).toBeNull()
    expect(exportFidelity(cast<ExportSheet[]>(sheets), 'xlsx').missing).toBeNull()
  })
})

describe('charts our model cannot express — reported, never faked', () => {
  it('reports them with a real reason instead of inventing a chart that plots different numbers', async () => {
    const { sheets, notes } = await importWorkbook(
      fixture('foreign-unreadable.xlsx').buffer, 'foreign-unreadable.xlsx'
    )

    // Crucially: NOT imported as some plausible-looking column chart. The
    // "Non-adjacent" chart draws series from B and D; the only rectangle that
    // contains both also contains C, so importing it as one range would silently
    // add a series the user never plotted. We refuse, and we say why.
    expect(sheets[0].charts ?? []).toHaveLength(0)

    expect(notes!.charts).toHaveLength(3)
    expect(notes!.charts.map((c) => c.title).sort()).toEqual(['Detached labels', 'Non-adjacent', 'Radar'])
    const reasonFor = (t: string) => notes!.charts.find((c) => c.title === t)!.reason
    expect(reasonFor('Radar')).toMatch(/radar.*aren’t supported/i)
    expect(reasonFor('Non-adjacent')).toMatch(/non-adjacent columns/i)
    expect(reasonFor('Detached labels')).toMatch(/category labels are not next to the data/i)
  })

  it('and the EXPORT says so, before the download, even after the user edits', async () => {
    const { sheets } = await importWorkbook(
      fixture('foreign-unreadable.xlsx').buffer, 'foreign-unreadable.xlsx'
    )

    const report = exportFidelity(cast<ExportSheet[]>(sheets), 'xlsx')
    expect(report.missing!.charts).toHaveLength(3)
    expect(report.missing!.filename).toBe('foreign-unreadable.xlsx')
    // The dialog must actually open — silence here is the whole bug.
    expect(exportNeedsConfirm(cast<ExportSheet[]>(sheets), 'xlsx')).toBe(true)
  })
})

describe('foreign .xlsx with a pivot table', () => {
  it('imports the pivot VALUES as cells but says the live pivot did not come with them', async () => {
    const { sheets, notes } = await importWorkbook(fixture('foreign-pivot.xlsx').buffer, 'foreign-pivot.xlsx')

    // The numbers are not lost — Excel renders a pivot into real cells and we read
    // them. What is lost is the pivot OBJECT, and that is what we must not hide.
    const pivotSheet = sheets.find((s) => s.name === 'PivotSheet')!
    expect(cellAt(pivotSheet, 3, 0)!.v).toBe('Grand Total')
    expect(cellAt(pivotSheet, 3, 1)!.v).toBe(65)

    expect(cast<{ pivots?: unknown[] }>(sheets[0]).pivots ?? []).toHaveLength(0)   // no live pivot in the model
    expect(notes!.pivots).toBe(1)
  })

  it('warns on export, because the exported file will NOT have the pivot table', async () => {
    const { sheets } = await importWorkbook(fixture('foreign-pivot.xlsx').buffer, 'foreign-pivot.xlsx')

    expect(exportNeedsConfirm(cast<ExportSheet[]>(sheets), 'xlsx')).toBe(true)
    expect(exportFidelity(cast<ExportSheet[]>(sheets), 'xlsx').missing!.pivots).toBe(1)

    // And the warning is TRUE — the export really has no pivot parts.
    await exportSheetsToXlsx(cast<ExportSheet[]>(sheets), 'out')
    const parts = await exportedParts()
    expect(parts.filter((n) => /pivot/i.test(n))).toEqual([])
  })
})
