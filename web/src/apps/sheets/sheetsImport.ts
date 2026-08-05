/**
 * sheetsImport.ts — .xlsx / .xls / .ods → Fortune-Sheet workbook model.
 * ----------------------------------------------------------------------------
 * SheetJS (`xlsx`, already a dependency) reads xlsx / xls / ods natively with a
 * hardened, external-entity-free XML parser, so it is the right lightweight
 * engine — no second spreadsheet library needed. This module wraps it in the
 * import trust boundary: a compressed-size gate, a per-sheet cell cap, a
 * sheet-count cap, and a declared-range clamp so a file that declares a bogus
 * `A1:XFD1048576` range can't drive an enormous allocation.
 *
 * FIDELITY: values, formulas (imported as DATA — see the SECURITY note), number
 * formats (currency/percent/date via the `z` code → Fortune-Sheet ct.fa), merged
 * cells, multiple sheets, and column widths + row heights all round-trip.
 *
 * SECURITY — formula injection: a cell may carry a formula (cell.f). We DO import
 * it as the cell's formula so a real spreadsheet stays functional, but the value
 * is stored as structured data — it is NEVER eval()'d by us, and Fortune-Sheet's
 * formula parser is a pure evaluator (no shell/DOM/network). The dangerous
 * direction is EXPORT to CSV, where a leading =/+/-/@ would be re-interpreted by
 * the opening app; that is neutralised in sheetsExport.csvField. Cell *display*
 * text is rendered by Fortune-Sheet as escaped text, never as HTML.
 */

import * as XLSX from 'xlsx'
import {
  assertFileSize, MAX_SHEETS, MAX_CELLS_PER_SHEET, MAX_ROWS, MAX_COLS, ImportError,
} from '../../lib/importBounds.js'
import { makeChart, type Chart, type ChartInput } from './charts.js'
import { CHART_META_SHEET } from './sheetsExport.js'
import { readXlsxCharts } from './xlsxChartsRead.js'
import { readOdsObjects } from './odsChartsRead.js'
import { makeImportNotes, setImportNotes, type ImportNotes, type INSheet } from './importNotes.js'

export interface ImportCellValue {
  v: string | number | boolean
  m: string
  ct: { t: string; fa?: string }
  f?: string
}
export interface ImportCellEntry { r: number; c: number; v: ImportCellValue }
export interface ImportSheetConfig {
  merge?: Record<string, { r: number; c: number; rs: number; cs: number }>
  columnlen?: Record<number, number>
  rowlen?: Record<number, number>
}
export interface ImportSheet {
  name: string
  celldata: ImportCellEntry[]
  config: ImportSheetConfig
  row: number
  column: number
  charts?: Chart[]
}

export interface ImportWorkbookResult {
  sheets: ImportSheet[]
  notes: ImportNotes | null
}

// A chart-definition sheet holds at most this many rows; a file claiming more is
// truncated rather than trusted (import trust boundary — the sheet is untrusted
// input like any other, even though WE normally write it).
const MAX_META_CHARTS = 200

/**
 * chartsFromMetaSheet — parse the "Vulos Charts" definition sheet back into live
 * chart descriptors (WAVE-64).
 *
 * This is the other half of the export round-trip: sheetsExport writes each
 * chart's type/range/title/options/geometry as rows, so re-importing the .xlsx
 * restores the charts EXACTLY rather than leaving the user with a mysterious
 * sheet of rows. (SheetJS cannot read the real OOXML chart parts we also embed,
 * so this sheet — not the chart XML — is what import reads.)
 *
 * SECURITY: the file is untrusted. Every descriptor goes through makeChart, the
 * same fail-closed clamp used at the CRDT ingress: unknown type → 'column',
 * geometry clamped to sane finite bounds, strings coerced + length-capped. A
 * sheet whose header is not ours is ignored entirely (returns []).
 */
export function chartsFromMetaSheet(ws: XLSX.WorkSheet | undefined): Chart[] {
  if (!ws || !ws['!ref']) return []
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false }) as unknown[][]
  const header = (rows[0] || []).map((h) => String(h ?? ''))
  if (header[0] !== 'type' || header[1] !== 'range') return []   // not our schema
  const col = (name: string) => header.indexOf(name)
  const idx = {
    type: col('type'), range: col('range'), title: col('title'),
    x1: col('xAxisLabel'), y1: col('yAxisLabel'), y2: col('y2AxisLabel'),
    legend: col('legend'), headerRow: col('headerRow'), headerCol: col('headerCol'),
    secondary: col('secondaryAxis'), bins: col('bins'),
    x: col('x'), y: col('y'), w: col('w'), h: col('h'), id: col('id'),
  }
  const get = (row: unknown[], i: number): unknown => (i >= 0 ? row[i] : undefined)
  const yes = (v: unknown, dflt: boolean): boolean => {
    if (v === undefined || v === null || v === '') return dflt
    const s = String(v).trim().toLowerCase()
    return s === 'yes' || s === 'true' || s === '1'
  }
  const out: Chart[] = []
  for (const row of rows.slice(1, MAX_META_CHARTS + 1)) {
    if (!Array.isArray(row) || row.every((c) => c === '' || c == null)) continue
    const type = String(get(row, idx.type) ?? '')
    if (!type) continue
    const geom: Partial<Record<'x' | 'y' | 'w' | 'h', number>> = {}
    // x/y may legitimately be 0 (a chart dragged flush to the grid origin), so
    // only w/h — where 0 means "absent", never "zero-sized" — require > 0. A
    // `v > 0` test on x/y would silently relocate every origin-anchored chart to
    // makeChart's default offset on re-import.
    for (const k of ['x', 'y'] as const) {
      const v = Number(get(row, idx[k]))
      if (isFinite(v) && v >= 0) geom[k] = v
    }
    for (const k of ['w', 'h'] as const) {
      const v = Number(get(row, idx[k]))
      if (isFinite(v) && v > 0) geom[k] = v
    }
    const idVal = get(row, idx.id)
    out.push(makeChart({
      // makeChart mints a fresh id when this is absent/invalid — an id is only a
      // local LWW key, so a file that omits it still round-trips fine.
      id: typeof idVal === 'string' ? idVal : undefined,
      type,
      range: String(get(row, idx.range) ?? ''),
      title: String(get(row, idx.title) ?? ''),
      options: {
        xAxisLabel:  String(get(row, idx.x1) ?? ''),
        yAxisLabel:  String(get(row, idx.y1) ?? ''),
        y2AxisLabel: String(get(row, idx.y2) ?? ''),
        legend:      yes(get(row, idx.legend), true),
        headerRow:   yes(get(row, idx.headerRow), true),
        headerCol:   yes(get(row, idx.headerCol), true),
        secondaryAxis: yes(get(row, idx.secondary), false),
        bins:        Number(get(row, idx.bins)),
      },
      ...geom,
    } as ChartInput))
  }
  return out
}

// Map a SheetJS cell type to a Fortune-Sheet ct.t code.
function ctType(t: unknown): string {
  if (t === 'n') return 'n'
  if (t === 'b') return 'b'
  if (t === 'd') return 'd'
  return 's'
}

function worksheetToSheet(ws: XLSX.WorkSheet | undefined, name: string): ImportSheet {
  if (!ws || !ws['!ref']) return { name, celldata: [], config: {}, row: 84, column: 60 }
  const range = XLSX.utils.decode_range(ws['!ref'] as string)
  // Clamp the declared range so a lying header can't force a huge iteration.
  const endR = Math.min(range.e.r, MAX_ROWS - 1)
  const endC = Math.min(range.e.c, MAX_COLS - 1)

  const celldata: ImportCellEntry[] = []
  for (let r = range.s.r; r <= endR; r++) {
    for (let c = range.s.c; c <= endC; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined
      if (!cell) continue
      if (celldata.length >= MAX_CELLS_PER_SHEET) {
        throw new ImportError(`Sheet "${name}" has more than ${MAX_CELLS_PER_SHEET} cells (import limit).`)
      }
      const v = cell.v ?? ''
      const m = cell.w != null ? String(cell.w) : String(v)
      const ct: { t: string; fa?: string } = { t: ctType(cell.t) }
      // Carry the number-format code (currency / percent / date) into ct.fa so
      // it round-trips back out on export. 'General' is the implicit default.
      if (cell.z && cell.z !== 'General') ct.fa = String(cell.z)
      const cellVal: ImportCellValue = { v: v as string | number | boolean, m, ct }
      // Import the formula as DATA (leading '='). We never evaluate it ourselves;
      // Fortune-Sheet's pure parser recomputes it on load. See the SECURITY note.
      if (cell.f) cellVal.f = `=${cell.f}`
      celldata.push({ r, c, v: cellVal })
    }
  }

  const config: ImportSheetConfig = {}

  // Merged cells → Fortune-Sheet config.merge.
  const merges = ws['!merges'] || []
  if (merges.length) {
    const mc: NonNullable<ImportSheetConfig['merge']> = {}
    for (const mg of merges) {
      mc[`${mg.s.r}_${mg.s.c}`] = { r: mg.s.r, c: mg.s.c, rs: mg.e.r - mg.s.r + 1, cs: mg.e.c - mg.s.c + 1 }
    }
    config.merge = mc
  }

  // Column widths → config.columnlen (px). SheetJS gives wpx or wch (chars).
  const cols = ws['!cols'] || []
  if (cols.length) {
    const columnlen: NonNullable<ImportSheetConfig['columnlen']> = {}
    cols.forEach((col, i) => {
      if (!col) return
      const px = Number.isFinite(col.wpx) ? col.wpx
        : Number.isFinite(col.width) ? Math.round((col.width as number) * 7)
        : Number.isFinite(col.wch) ? Math.round((col.wch as number) * 7)
        : null
      if (px != null && px > 0) columnlen[i] = Math.min(px, 2000)
    })
    if (Object.keys(columnlen).length) config.columnlen = columnlen
  }

  // Row heights → config.rowlen (px). SheetJS gives hpx or hpt (points).
  const rows = ws['!rows'] || []
  if (rows.length) {
    const rowlen: NonNullable<ImportSheetConfig['rowlen']> = {}
    rows.forEach((row, i) => {
      if (!row) return
      const px = Number.isFinite(row.hpx) ? row.hpx
        : Number.isFinite(row.hpt) ? Math.round((row.hpt as number) * 96 / 72)
        : null
      if (px != null && px > 0) rowlen[i] = Math.min(px, 1000)
    })
    if (Object.keys(rowlen).length) config.rowlen = rowlen
  }

  return { name, celldata, config, row: Math.max(84, endR + 10), column: Math.max(60, endC + 5) }
}

/**
 * workbookToSheets — parse an xlsx/xls/ods ArrayBuffer into the Fortune-Sheet
 * data array. Enforces the file-size gate + sheet/cell caps. `cellStyles:true`
 * pulls in column/row metadata; we deliberately do NOT enable `bookVBA` or any
 * macro extraction — a macro-laden workbook is imported as inert data only.
 */
export function workbookToSheets(arrayBuffer: ArrayBuffer, filename = 'file'): ImportSheet[] {
  assertFileSize(arrayBuffer.byteLength, filename)
  let wb: XLSX.WorkBook
  try {
    wb = XLSX.read(arrayBuffer, { type: 'array', cellStyles: true, cellNF: true, dense: false })
  } catch (e) {
    throw new ImportError(`Could not read ${filename}: ${e instanceof Error ? e.message : String(e)}`)
  }
  const names = wb.SheetNames.slice(0, MAX_SHEETS)
  if (wb.SheetNames.length > MAX_SHEETS) {
    throw new ImportError(`${filename} has more than ${MAX_SHEETS} sheets (import limit).`)
  }
  // WAVE-64: lift our chart-definition sheet out of the workbook and turn it back
  // into live charts on the first sheet — it is bookkeeping, not user data, so it
  // must not show up as a stray worksheet full of rows.
  const charts = chartsFromMetaSheet(wb.Sheets[CHART_META_SHEET])
  const visible = names.filter((n) => !(n === CHART_META_SHEET && charts.length))

  const out = visible.map((name) => worksheetToSheet(wb.Sheets[name], name))
  if (!out.length) return [{ name: 'Sheet1', celldata: [], config: {}, row: 84, column: 60 }]
  if (charts.length) out[0] = { ...out[0], charts }
  return out
}

/** Display text of a cell in an already-parsed sheet (for resolving a chart title held in a cell). */
function cellReader(sheet: ImportSheet | undefined): (r: number, c: number) => string {
  const idx = new Map<string, ImportCellValue>()
  for (const cd of sheet?.celldata || []) idx.set(`${cd.r},${cd.c}`, cd.v)
  return (r: number, c: number) => {
    const v = idx.get(`${r},${c}`)
    if (!v) return ''
    return String(v.m ?? v.v ?? '')
  }
}

/**
 * importWorkbook — the FULL import: cells (workbookToSheets) PLUS the parts
 * SheetJS cannot see — real OOXML charts, and the presence of pivot tables.
 *
 * THE BUG THIS FIXES (measured, not assumed). Before this existed, importing an
 * .xlsx that Excel/Sheets/openpyxl had written with charts produced a workbook
 * with the cells and NO charts — and re-exporting it wrote a file with no charts.
 * Three charts in, zero out, no warning: silent data loss on the most ordinary
 * possible round-trip (open a spreadsheet, change a number, save it back).
 *
 * Two carriers, in priority order:
 *   1. The "Vulos Charts" definition sheet, if present. That is OUR OWN export,
 *      and it is lossless (it holds the exact descriptor, geometry included), so
 *      it always wins — there is nothing to gain from re-deriving it from XML.
 *   2. Otherwise the real chart parts (xlsxChartsRead), for a FOREIGN file.
 *
 * Whatever cannot be represented faithfully is NOT approximated — it is recorded
 * in importNotes and reported, so the user hears it from us instead of finding out
 * when they reopen their file in Excel. Returns { sheets, notes }.
 *
 * Async because reading the package means re-opening the ZIP (JSZip).
 */
export async function importWorkbook(arrayBuffer: ArrayBuffer, filename = 'file'): Promise<ImportWorkbookResult> {
  const sheets = workbookToSheets(arrayBuffer, filename)

  // Charts live on the first sheet and read its cells (charts.js getCharts), so
  // that is the sheet a foreign chart must reference to be representable.
  const first = sheets[0]
  const isXlsx = /\.xlsx$/i.test(filename)
  const isOds = /\.ods$/i.test(filename)
  const alreadyHasCharts = Array.isArray(first?.charts) && first.charts.length > 0

  // .ods honesty (mirrors the .xlsx importNotes pattern). SheetJS brings in .ods
  // CELLS but nothing about .ods charts/pivots, and Vulos has no .ods chart
  // reader — so every chart in an .ods is a LOSS. Detect and report it (never drop
  // it silently); we do NOT approximate the charts, we count them so the user is
  // told, at import and again at export.
  if (isOds) {
    let found = { charts: 0, pivots: 0 }
    try {
      found = await readOdsObjects(arrayBuffer)
    } catch {
      return { sheets, notes: null } // detection failure must not fail the import
    }
    const notes = makeImportNotes({
      charts: Array.from({ length: found.charts }, () => ({
        title: '',
        reason: 'Vulos can’t import charts from an .ods (OpenDocument) file',
      })),
      pivots: found.pivots,
      filename,
    })
    let out: ImportSheet[] = sheets
    if (notes) out = setImportNotes(out as unknown as INSheet[], notes) as unknown as ImportSheet[]
    return { sheets: out, notes }
  }

  if (!isXlsx) return { sheets, notes: null }

  let found: Awaited<ReturnType<typeof readXlsxCharts>> = { charts: [], unreadable: [], pivots: 0 }
  try {
    found = await readXlsxCharts(arrayBuffer, first?.name, cellReader(first))
  } catch {
    // A decorative part we cannot parse must never fail the whole import — the
    // cells still arrive. (readXlsxCharts is already fail-soft; this is belt.)
    return { sheets, notes: null }
  }

  let out: ImportSheet[] = sheets
  // Our own export (case 1): the definition sheet already restored the charts
  // exactly. Do not double-import them from the XML we wrote alongside it.
  if (!alreadyHasCharts && found.charts.length) {
    out = out.map((s, i) => (i === 0 ? { ...s, charts: found.charts } : s))
  }

  const notes = makeImportNotes({
    // A chart we could not read is only a LOSS if we did not already have it from
    // the definition sheet (our own export writes a histogram's values into the
    // chart part, which the XML reader rightly declines to re-derive).
    charts: alreadyHasCharts ? [] : found.unreadable,
    pivots: found.pivots,
    filename,
  })
  if (notes) out = setImportNotes(out as unknown as INSheet[], notes) as unknown as ImportSheet[]
  return { sheets: out, notes }
}
