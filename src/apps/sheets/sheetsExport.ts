import * as XLSX from 'xlsx'
import { saveAs } from 'file-saver'
import { escapeChartText, type Chart, type ChartSheet } from './charts.js'
import { injectChartsIntoXlsx, nativeXlsxSupport, type SkippedChart } from './xlsxCharts.js'
import { getImportNotes, type ImportNoteChart } from './importNotes.js'

export interface MergeCell { r: number; c: number; rs?: number; cs?: number }
export interface ExportSheetConfig {
  merge?: Record<string, MergeCell>
  columnlen?: Record<string, number>
  rowlen?: Record<string, number>
  [key: string]: unknown
}
export interface ExportCellValue {
  v?: string | number | boolean
  m?: string | number
  f?: string
  ct?: { fa?: string; t?: string }
  [key: string]: unknown
}
export interface ExportCellEntry {
  r: number
  c: number
  v?: ExportCellValue | null
}
export interface ExportSheet {
  name?: string
  celldata?: ExportCellEntry[]
  charts?: Chart[]
  pivots?: unknown[]
  config?: ExportSheetConfig
  [key: string]: unknown
}

export interface DroppedChart { type: string; title: string; note: string }
export interface MissingInfo { pivots: number; charts: ImportNoteChart[]; filename: string }
export interface ExportFidelityReport {
  format: string
  charts: number
  pivots: number
  native: number
  degraded: DroppedChart[]
  lost: DroppedChart[]
  notes: string[]
  missing: MissingInfo | null
}

/** The worksheet that carries our chart definitions (see chartsMetaSheet). */
export const CHART_META_SHEET = 'Vulos Charts'

/**
 * CHART_META_COLUMNS — the metadata sheet's schema. The first eight columns are
 * the original WAVE-54 set (kept in place so an older export still parses); the
 * rest were added in WAVE-64 to make the sheet a LOSSLESS round-trip of the
 * descriptor: re-importing the .xlsx restores each chart's type, range, title,
 * options AND its position/size over the grid.
 */
export const CHART_META_COLUMNS = [
  'type', 'range', 'title', 'xAxisLabel', 'yAxisLabel', 'legend', 'headerRow', 'headerCol',
  'y2AxisLabel', 'secondaryAxis', 'bins', 'x', 'y', 'w', 'h', 'id',
]

export function fortuneToWorksheet(sheet: ExportSheet): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = {}
  const cells = sheet.celldata || []
  let maxR = 0, maxC = 0
  for (const { r, c, v } of cells) {
    if (!v) continue
    const raw = v.v !== undefined ? v.v : v.m
    const cell: XLSX.CellObject = { v: raw, t: typeof raw === 'number' ? 'n' : 's' }
    // DATA-INTEGRITY: preserve the cell FORMULA on export. sheetsImport stores an
    // imported formula as `v.f = "=..."` (leading '='), and the import docstring
    // promises formulas round-trip — but without this the exporter wrote only the
    // cached value, silently converting every formula to a static number on
    // xlsx→edit→xlsx (or ods). SheetJS wants the formula WITHOUT the leading '=';
    // we keep `v` too as the cached value so non-recalculating readers still show
    // a result. (xlsx/ods are binary formats, not re-parsed as text like CSV, so
    // this is not the CSV-injection surface guarded by csvField.)
    if (v.f != null && v.f !== '') {
      cell.f = String(v.f).replace(/^=/, '')
    }
    // Carry the cell's number-format code (Fortune Sheet ct.fa) into the xlsx
    // `z` field so currency/percent/date presets round-trip to Excel. 'General'
    // is the default and needs no explicit format.
    const fa = v.ct?.fa
    if (fa && fa !== 'General') cell.z = fa
    ws[XLSX.utils.encode_cell({ r, c })] = cell
    if (r > maxR) maxR = r
    if (c > maxC) maxC = c
  }
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } })
  // Restore merged cells from Fortune Sheet config.merge → xlsx !merges
  const mc = sheet.config?.merge
  if (mc && typeof mc === 'object') {
    ws['!merges'] = Object.values(mc).map(m => ({
      s: { r: m.r, c: m.c },
      e: { r: m.r + (m.rs || 1) - 1, c: m.c + (m.cs || 1) - 1 },
    }))
  }
  // DATA-INTEGRITY: restore column widths / row heights. sheetsImport reads these
  // into config.columnlen / config.rowlen (px) and the docstring promises they
  // round-trip, but the exporter previously emitted neither — so every column
  // flattened to default width and every row to default height on round-trip.
  const columnlen = sheet.config?.columnlen
  if (columnlen && typeof columnlen === 'object') {
    const colArr: XLSX.ColInfo[] = []
    for (const [i, px] of Object.entries(columnlen)) {
      const idx = Number(i)
      if (Number.isInteger(idx) && idx >= 0 && Number.isFinite(px) && px > 0) {
        colArr[idx] = { wpx: px }
      }
    }
    if (colArr.length) ws['!cols'] = colArr
  }
  const rowlen = sheet.config?.rowlen
  if (rowlen && typeof rowlen === 'object') {
    const rowArr: XLSX.RowInfo[] = []
    for (const [i, px] of Object.entries(rowlen)) {
      const idx = Number(i)
      if (Number.isInteger(idx) && idx >= 0 && Number.isFinite(px) && px > 0) {
        rowArr[idx] = { hpx: px }
      }
    }
    if (rowArr.length) ws['!rows'] = rowArr
  }
  return ws
}

/**
 * chartsMetaSheet — the chart DEFINITIONS as a worksheet.
 *
 * WAVE-64: the .xlsx export now also writes REAL OOXML chart parts (see
 * xlsxCharts.js), so an exported chart opens as a live Excel chart. This sheet is
 * still written, for two reasons:
 *
 *   1. ROUND TRIP. Excel's chart XML cannot express everything our descriptor
 *      holds (its exact pixel position over the grid, our histogram bin count,
 *      which of our types it was). SheetJS cannot READ chart parts back either.
 *      So this sheet is what makes import lossless: sheetsImport parses it and
 *      restores every chart exactly as it was.
 *   2. ODS. SheetJS writes ODS from the same worksheet model and there is no
 *      equivalent injection path, so for .ods this sheet is the ONLY carrier —
 *      which the export dialog states plainly instead of dropping charts quietly.
 *
 * SECURITY (WAVE-55): title / range / axis labels can originate from cell data
 * (or a hostile CRDT peer). Every free-text field goes through escapeChartText so
 * a leading =/+/-/@ is neutralised with a quote — otherwise a title like
 * `=HYPERLINK("http://evil")` would be written as a LIVE FORMULA into the
 * exported worksheet and evaluate when opened in Excel (formula injection).
 * The type / legend / header / secondaryAxis columns are fixed enums and the
 * geometry columns are numbers, so neither is a free-text surface.
 */
export function chartsMetaSheet(data: ExportSheet[] | null | undefined): XLSX.WorkSheet | null {
  const charts = data?.[0]?.charts
  if (!Array.isArray(charts) || charts.length === 0) return null
  const rows: unknown[][] = [CHART_META_COLUMNS.slice()]
  const yn = (v: unknown, dflt = true) => ((v === undefined ? dflt : v) ? 'yes' : 'no')
  for (const c of charts) {
    rows.push([
      String(c.type ?? ''),
      escapeChartText(c.range ?? ''),
      escapeChartText(c.title ?? ''),
      escapeChartText(c.options?.xAxisLabel ?? ''),
      escapeChartText(c.options?.yAxisLabel ?? ''),
      c.options?.legend === false ? 'no' : 'yes',
      c.options?.headerRow === false ? 'no' : 'yes',
      c.options?.headerCol === false ? 'no' : 'yes',
      escapeChartText(c.options?.y2AxisLabel ?? ''),
      yn(c.options?.secondaryAxis === true, false),
      Number(c.options?.bins) || 10,
      Number(c.x) || 0,
      Number(c.y) || 0,
      Number(c.w) || 0,
      Number(c.h) || 0,
      escapeChartText(c.id ?? '', 64),
    ])
  }
  return XLSX.utils.aoa_to_sheet(rows)
}

/**
 * exportFidelity — what will actually survive this export, in the user's words.
 *
 * This is the data behind the export dialog. Nothing about a chart may be lost
 * WITHOUT the user being told first, so the report is computed from the same
 * predicate the writer uses (nativeXlsxSupport) rather than from a hand-kept list
 * that could drift out of sync with it.
 *
 * Returns { format, charts, pivots, native, degraded[], lost[], notes[], missing }.
 *
 * `missing` is the OTHER half of honesty, and the easy one to forget: content the
 * IMPORT could never bring in (see importNotes.js). By export time it is not in
 * the workbook, so nothing here could detect it — yet this is the exact moment the
 * user is about to write a file back over the original that still HAS it. So the
 * import wrote down what it dropped, and we say it again here.
 */
export function exportFidelity(data: ExportSheet[] | null | undefined, format: string): ExportFidelityReport {
  const charts = Array.isArray(data?.[0]?.charts) ? data![0].charts! : []
  const pivots = Array.isArray(data?.[0]?.pivots) ? data![0].pivots! : []
  const imported = getImportNotes(data)
  const report: ExportFidelityReport = {
    format, charts: charts.length, pivots: pivots.length, native: 0,
    degraded: [], lost: [], notes: [],
    missing: imported ? { pivots: imported.pivots, charts: imported.charts, filename: imported.filename || '' } : null,
  }

  if (format === 'xlsx') {
    for (const c of charts) {
      const s = nativeXlsxSupport(c.type)
      if (s.native && !s.note) report.native++
      else if (s.native) { report.native++; report.degraded.push({ type: c.type, title: c.title || '', note: s.note as string }) }
      else report.lost.push({ type: c.type, title: c.title || '', note: s.note || 'no Excel equivalent' })
    }
    if (charts.length) {
      report.notes.push(
        `${charts.length} chart${charts.length === 1 ? '' : 's'} will be embedded as ${charts.length === 1 ? 'a real Excel chart' : 'real Excel charts'} linked to the cells.`
      )
      report.notes.push(`Definitions are also written to a “${CHART_META_SHEET}” sheet, so re-importing this file into Vulos restores the charts exactly.`)
    }
  } else if (format === 'ods') {
    // No OOXML injection path for ODS — charts survive only as the definition sheet.
    report.lost = charts.map((c) => ({ type: c.type, title: c.title || '', note: 'ODS export cannot embed charts' }))
    if (charts.length) {
      report.notes.push(`${charts.length} chart${charts.length === 1 ? '' : 's'} cannot be embedded in .ods and will be exported as a “${CHART_META_SHEET}” data sheet instead.`)
      report.notes.push('Re-importing the file into Vulos restores them; other spreadsheet apps will see the definitions as plain rows, not charts.')
    }
  } else if (format === 'csv') {
    report.lost = charts.map((c) => ({ type: c.type, title: c.title || '', note: 'CSV holds values only' }))
    if (charts.length) report.notes.push(`CSV holds values only — ${charts.length} chart${charts.length === 1 ? '' : 's'} will NOT be included.`)
    report.notes.push('CSV exports the FIRST sheet only.')
  } else if (format === 'xlsx-server') {
    // The server-side exporter (Go) writes CELLS ONLY — it has no chart writer.
    // It is reachable from the same Export menu, so it gets the same honesty: a
    // chart dropped by the server path is still a chart the user lost.
    report.lost = charts.map((c) => ({ type: c.type, title: c.title || '', note: 'the server exporter writes cells only' }))
    if (charts.length) {
      report.notes.push('Export “Excel workbook” instead to keep your charts — the server export writes cells only.')
    }
    report.notes.push('The server export uses the LAST SAVED version of this file, not unsaved edits.')
  }

  if (pivots.length) {
    report.notes.push(
      `${pivots.length} live pivot table${pivots.length === 1 ? '' : 's'} ${pivots.length === 1 ? 'is' : 'are'} not exported. ` +
      'Use “Insert as static sheet” in the pivot panel to write the result into real cells first.'
    )
  }
  return report
}

/**
 * exportNeedsConfirm — does this export have anything the user must be told
 * BEFORE it happens? A plain workbook (no charts, no live pivots, nothing dropped
 * at import) exports with zero friction; anything that loses or degrades content
 * goes through the dialog.
 */
export function exportNeedsConfirm(data: ExportSheet[] | null | undefined, format: string): boolean {
  const r = exportFidelity(data, format)
  const missing = !!r.missing && (r.missing.pivots > 0 || r.missing.charts.length > 0)
  return r.lost.length > 0 || r.degraded.length > 0 || r.pivots > 0 || missing ||
    (r.charts > 0 && format !== 'xlsx')
}

/**
 * exportSheetsToXlsx — write the workbook, INCLUDING real OOXML charts.
 *
 * Async because the chart injection re-opens the ZIP SheetJS produced (JSZip).
 * Resolves with the injection result ({ embedded, skipped }) so a caller can
 * surface what happened; nothing here throws away a chart quietly.
 */
export async function exportSheetsToXlsx(data: ExportSheet[], filename: string): Promise<{ embedded: string[]; skipped: SkippedChart[] }> {
  const wb = XLSX.utils.book_new()
  for (const sheet of data) {
    XLSX.utils.book_append_sheet(wb, fortuneToWorksheet(sheet), sheet.name || 'Sheet')
  }
  // The chart-definition sheet (round-trip carrier). Hidden in Excel: it is our
  // bookkeeping, not the user's data — but it is DATA, not a chart, so it must
  // never be the only thing we do (see the injection below).
  const meta = chartsMetaSheet(data)
  if (meta) {
    XLSX.utils.book_append_sheet(wb, meta, CHART_META_SHEET)
    wb.Workbook = wb.Workbook || {}
    wb.Workbook.Sheets = wb.SheetNames.map((n) => ({ Hidden: n === CHART_META_SHEET ? 1 : 0 }))
  }
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as Parameters<typeof injectChartsIntoXlsx>[0]

  const charts = Array.isArray(data?.[0]?.charts) ? data[0].charts! : []
  const { buffer, embedded, skipped } = await injectChartsIntoXlsx(buf, charts, (data?.[0] || {}) as ChartSheet)
  saveAs(
    new Blob([buffer as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    `${filename}.xlsx`
  )
  return { embedded, skipped }
}

// Serialise ONE cell value into a CSV field.
//
// SECURITY (formula / CSV injection): a cell value is untrusted — a hostile CRDT
// peer can set any cell to an arbitrary STRING (grid_op), and imports carry
// attacker text too. A string that a spreadsheet re-parses as a formula/command
// when the exported .csv is opened (leading `= + - @`, or a TAB / CR that Excel
// also treats as a formula lead-in) is neutralised with a leading apostrophe —
// the same guard escapeChartText/pivotText already apply on their surfaces.
// NUMERIC cells are emitted verbatim: they are typed `number` here (FortuneSheet
// stores computed values as numbers), can never carry a payload, and prefixing a
// legitimate negative number like `-5` would corrupt the data — so the guard is
// scoped to string cells only.
export function csvField(cell: unknown): string {
  if (typeof cell === 'number') return String(cell)
  let s = String(cell ?? '')
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Build the CSV text for the first sheet (pure — no side effects, testable). */
export function buildCsv(data: ExportSheet[] | null | undefined): string {
  const sheet = data?.[0]
  if (!sheet) return ''
  const cells = sheet.celldata || []
  let maxR = 0, maxC = 0
  for (const { r, c } of cells) { if (r > maxR) maxR = r; if (c > maxC) maxC = c }
  const grid: unknown[][] = Array.from({ length: maxR + 1 }, () => new Array(maxC + 1).fill(''))
  for (const { r, c, v } of cells) {
    if (!v) continue
    grid[r][c] = v.v !== undefined ? v.v : (v.m ?? '')
  }
  return grid.map((row) => row.map(csvField).join(',')).join('\n')
}

export function exportSheetsToCsv(data: ExportSheet[] | null | undefined, filename: string): void {
  if (!data?.[0]) return
  const csv = buildCsv(data)
  saveAs(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${filename}.csv`)
}

/**
 * exportSheetsToOds — write the workbook as OpenDocument Spreadsheet (.ods).
 * SheetJS emits ODS natively (`bookType: 'ods'`), so the SAME fortuneToWorksheet
 * mapping (values, number formats via `z`, merged cells, multiple sheets) is
 * reused — round-trips cleanly with the xlsx path. Formula-injection is not a
 * concern for the binary ODS body (cells are typed, not re-parsed as text like a
 * CSV); the chart-metadata sheet still runs through escapeChartText.
 *
 * CHARTS: there is no ODS chart-injection path (an ODS chart is a whole embedded
 * sub-document, not a single XML part), so charts here survive ONLY as the
 * definition sheet — and exportFidelity('ods') says exactly that before the user
 * commits to the download.
 */
export function exportSheetsToOds(data: ExportSheet[], filename: string): void {
  const wb = XLSX.utils.book_new()
  for (const sheet of data) {
    XLSX.utils.book_append_sheet(wb, fortuneToWorksheet(sheet), sheet.name || 'Sheet')
  }
  const meta = chartsMetaSheet(data)
  if (meta) XLSX.utils.book_append_sheet(wb, meta, CHART_META_SHEET)
  const buf = XLSX.write(wb, { bookType: 'ods', type: 'array' })
  saveAs(new Blob([buf], { type: 'application/vnd.oasis.opendocument.spreadsheet' }), `${filename}.ods`)
}
