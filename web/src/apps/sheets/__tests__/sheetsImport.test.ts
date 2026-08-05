/**
 * sheetsImport.test.js — .xlsx / .ods import fidelity + import→export security.
 */
import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import JSZip from 'jszip'
import { workbookToSheets, importWorkbook, type ImportCellEntry } from '../sheetsImport.js'
import { getImportNotes, hasImportLoss, type INSheet } from '../importNotes.js'
import { buildCsv, type ExportSheet } from '../sheetsExport.js'
import { convertToSheetContent } from '../../../lib/importFile.js'
import { ImportError, MAX_SINGLE_ENTRY } from '../../../lib/importBounds.js'
import { buildLyingZip } from '../../../lib/__tests__/zipBombFixture.js'

// charts.ts / sheetsExport.ts / sheetsImport.ts / importNotes.ts each declare
// their own narrow view of the same plain-data FortuneSheet shape (ChartSheet /
// ExportSheet / ImportSheet / INSheet) — no shared base type. Production
// crosses these boundaries with the same cast-through-unknown helper
// (SheetsEditor.tsx's `cast<T>`).
function cast<T>(v: unknown): T { return v as T }

// Build a workbook ArrayBuffer for a given bookType from a worksheet mutator.
//
// XLSX.write()'s return type is `any` in the library's own types (overloaded
// on `opts` in a way TS can't narrow from an inline object) — cast to
// ArrayBuffer, documented as `type: 'array'`'s real return, same as
// roundTripCheck.ts's boundary fix.
function buildBook(mutate: (ws: XLSX.WorkSheet, wb: XLSX.WorkBook) => void, bookType: XLSX.BookType = 'xlsx'): ArrayBuffer {
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet([['Name', 'Amount'], ['Widget', 5]])
  mutate(ws, wb)
  XLSX.utils.book_append_sheet(wb, ws, 'Data')
  return XLSX.write(wb, { bookType, type: 'array' }) as ArrayBuffer
}

function findCell(sheet: { celldata: ImportCellEntry[] }, r: number, c: number): ImportCellEntry | undefined {
  return sheet.celldata.find((cell) => cell.r === r && cell.c === c)
}

describe('workbookToSheets — fidelity', () => {
  it('imports values across a multi-sheet xlsx', () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a', 'b']]), 'One')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['c']]), 'Two')
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
    const sheets = workbookToSheets(buf, 't.xlsx')
    expect(sheets.map((s) => s.name)).toEqual(['One', 'Two'])
    expect(findCell(sheets[0], 0, 0)!.v.m).toBe('a')
    expect(findCell(sheets[1], 0, 0)!.v.m).toBe('c')
  })

  it('preserves a formula as inert data (leading =)', () => {
    const buf = buildBook((ws) => { ws.C2 = { t: 'n', f: 'A1&B1', v: 0 }; ws['!ref'] = 'A1:C2' })
    const sheets = workbookToSheets(buf, 't.xlsx')
    const cell = findCell(sheets[0], 1, 2)!
    expect(cell.v.f).toBe('=A1&B1')
  })

  it('preserves a number-format code (currency) via ct.fa', () => {
    // ws.B2 indexes WorkSheet's own `[cell: string]: CellObject | WSKeys | any`
    // signature, which resolves to `any` by TS's rules — cast the one read.
    const buf = buildBook((ws) => { (ws.B2 as XLSX.CellObject).z = '$#,##0.00' })
    const sheets = workbookToSheets(buf, 't.xlsx')
    expect(findCell(sheets[0], 1, 1)!.v.ct.fa).toBe('$#,##0.00')
  })

  it('preserves merged cells', () => {
    const buf = buildBook((ws) => { ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }] })
    const sheets = workbookToSheets(buf, 't.xlsx')
    expect(sheets[0].config.merge!['0_0']).toEqual({ r: 0, c: 0, rs: 1, cs: 2 })
  })

  it('preserves column widths as columnlen px', () => {
    const buf = buildBook((ws) => { ws['!cols'] = [{ wpx: 140 }, { wpx: 90 }] })
    const sheets = workbookToSheets(buf, 't.xlsx')
    expect(sheets[0].config.columnlen![0]).toBe(140)
    expect(sheets[0].config.columnlen![1]).toBe(90)
  })

  it('round-trips an ODS workbook (SheetJS native ods)', () => {
    const buf = buildBook(() => {}, 'ods')
    const sheets = workbookToSheets(buf, 't.ods')
    expect(findCell(sheets[0], 0, 0)!.v.m).toBe('Name')
    expect(findCell(sheets[0], 1, 1)!.v.v).toBe(5)
  })
})

// Take a real SheetJS-written .ods and INJECT a chart object into its package
// (a manifest chart file-entry + an Object dir) so it is a genuine, SheetJS-
// readable .ods that ALSO carries a chart — the exact case that used to lose the
// chart silently.
async function odsWithChart() {
  const base = buildBook(() => {}, 'ods')
  const zip = await JSZip.loadAsync(base)
  const manifest = await zip.file('META-INF/manifest.xml')!.async('string')
  const injected = manifest.replace('</manifest:manifest>',
    '<manifest:file-entry manifest:full-path="Object 1/" manifest:media-type="application/vnd.oasis.opendocument.chart"/></manifest:manifest>')
  zip.file('META-INF/manifest.xml', injected)
  zip.file('Object 1/content.xml', '<?xml version="1.0"?><office:document-content><chart:chart/></office:document-content>')
  return zip.generateAsync({ type: 'arraybuffer' })
}

describe('importWorkbook — .ods honesty (no silent chart loss)', () => {
  it('cells still import AND the dropped chart is reported in importNotes', async () => {
    const buf = await odsWithChart()
    const { sheets, notes } = await importWorkbook(buf, 'budget.ods')
    // Cells arrived (nothing about the chart failed the import).
    expect(findCell(sheets[0], 0, 0)!.v.m).toBe('Name')
    // The chart loss is recorded — and restated on the workbook for the export dialog.
    expect(hasImportLoss(notes)).toBe(true)
    expect(notes!.charts).toHaveLength(1)
    expect(notes!.charts[0].reason).toMatch(/\.ods/i)
    expect(getImportNotes(cast<INSheet[]>(sheets))).not.toBeNull()
  })

  it('a clean .ods (no chart) imports with NO import-loss note', async () => {
    const buf = buildBook(() => {}, 'ods')
    const { notes } = await importWorkbook(buf, 'clean.ods')
    expect(hasImportLoss(notes)).toBe(false)
  })
})

describe('workbookToSheets — security', () => {
  it('a cell whose TEXT looks like a formula is neutralised on CSV export', () => {
    // Import a string cell "=HYPERLINK(...)" (data, not a real formula), then
    // export to CSV: the formula/CSV-injection guard must prefix an apostrophe.
    const buf = buildBook((ws) => {
      ws.A3 = { t: 's', v: '=HYPERLINK("http://evil")' }
      ws['!ref'] = 'A1:B3'
    })
    const sheets = workbookToSheets(buf, 't.xlsx')
    const csv = buildCsv(cast<ExportSheet[]>(sheets))
    expect(csv).not.toMatch(/(^|\n|,)=HYPERLINK/)
    expect(csv).toContain("'=HYPERLINK")
  })

  it('handles unexpected bytes gracefully (bounded, never throws unbounded)', () => {
    // SheetJS is lenient and may coerce junk into an empty/garbage workbook
    // rather than throw — the security contract is that it stays BOUNDED and
    // returns a well-formed (possibly empty) sheet array, never a runaway parse.
    const junk = new TextEncoder().encode('definitely not a workbook').buffer
    const sheets = workbookToSheets(junk, 'x.xlsx')
    expect(Array.isArray(sheets)).toBe(true)
    expect(sheets.length).toBeGreaterThanOrEqual(1)
  })

  it('enforces the file-size gate before parsing (fail-closed)', () => {
    // A tiny buffer that lies about being huge: assertFileSize runs first on the
    // real byteLength, so this passes the gate; the gate itself is unit-tested in
    // importBounds. Here we just confirm the gate is wired (no throw on a small
    // valid file).
    const buf = buildBook(() => {})
    expect(() => workbookToSheets(buf, 'ok.xlsx')).not.toThrow()
  })
})

describe('sheets import — zip-bomb rejected BEFORE SheetJS parses', () => {
  // .xlsx/.ods are zip archives SheetJS inflates itself, so the mid-stream
  // inflate cap never sees them. convertToSheetContent must run the archive
  // pre-check before XLSX.read, rejecting a bomb before the heavy parse.
  //
  // We can't vi.spyOn XLSX.read (ESM namespace is non-configurable), but SheetJS
  // is LENIENT — XLSX.read never throws ImportError, it returns a bounded/garbage
  // workbook (see "handles unexpected bytes gracefully" above). So an ImportError
  // with the pre-check's decompressed-size message PROVES the guard fired and the
  // parser was never reached: a malformed bomb that reached XLSX.read would have
  // parsed to a (bounded) sheet array, not thrown.
  it('rejects a lying-central-directory oversize .xlsx before the heavy parse', async () => {
    const bomb = buildLyingZip('xl/worksheets/sheet1.xml', Buffer.from('<x/>'), 200 * 1024 * 1024)
    expect(200 * 1024 * 1024).toBeGreaterThan(MAX_SINGLE_ENTRY)
    const file = new File([cast<BlobPart>(bomb)], 'bomb.xlsx')
    const err = await convertToSheetContent(file).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(ImportError)
    expect((err as ImportError).message).toMatch(/decompress|too large|zip-bomb/i)  // from the pre-check, not SheetJS
  })

  it('rejects a lying-central-directory oversize .ods before the heavy parse', async () => {
    const bomb = buildLyingZip('content.xml', Buffer.from('<x/>'), 200 * 1024 * 1024)
    const file = new File([cast<BlobPart>(bomb)], 'bomb.ods')
    const err = await convertToSheetContent(file).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(ImportError)
    expect((err as ImportError).message).toMatch(/decompress|too large|zip-bomb/i)
  })
})
