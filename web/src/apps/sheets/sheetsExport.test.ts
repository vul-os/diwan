/**
 * sheetsExport.test.js — SECURITY regression (sec/office-deep).
 *
 * CSV export flows UNTRUSTED cell values (settable by a hostile CRDT peer via a
 * grid_op, or carried in by an import) straight into a .csv file. A value that a
 * spreadsheet re-parses as a formula/command when the file is opened (leading
 * `= + - @`, or a TAB/CR lead-in) must be neutralised, or opening the export in
 * Excel/Sheets executes it (formula / CSV injection, incl. data exfil via
 * =HYPERLINK/=WEBSERVICE). The chart-metadata sheet was already guarded
 * (escapeChartText) — these pin the same contract for the plain-cell CSV path.
 */
import { describe, it, expect } from 'vitest'
import { csvField, buildCsv } from './sheetsExport.js'
import type { ExportSheet } from './sheetsExport.js'

describe('CSV export — formula/CSV-injection guard', () => {
  it('neutralises every leading formula/command trigger on string cells', () => {
    for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
      const out = csvField(`${lead}HYPERLINK("http://evil")`)
      // Field is prefixed with an apostrophe so a spreadsheet treats it as text.
      // (It is additionally CSV-quoted when it contains a comma/quote.)
      const unquoted = out.startsWith('"') ? out.slice(1) : out
      expect(unquoted.startsWith("'")).toBe(true)
      // The raw payload can never begin the field (which is what makes it a formula).
      expect(out.replace(/^"/, '').startsWith(lead)).toBe(false)
    }
  })

  it('does NOT corrupt legitimate numeric cells (negative numbers stay numeric)', () => {
    expect(csvField(-5)).toBe('-5')
    expect(csvField(0)).toBe('0')
    expect(csvField(3.14)).toBe('3.14')
    // A negative number must not gain a formula-guard apostrophe.
    expect(csvField(-5).startsWith("'")).toBe(false)
  })

  it('still quotes+escapes ordinary text containing commas/quotes/newlines', () => {
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('plain')).toBe('plain')
  })

  it('buildCsv neutralises a hostile cell value but preserves numbers', () => {
    const data: ExportSheet[] = [{
      name: 'S', config: {},
      celldata: [
        { r: 0, c: 0, v: { v: '=cmd|\'/c calc\'!A1' } }, // hostile string cell
        { r: 0, c: 1, v: { v: -5 } },                     // numeric negative
        { r: 1, c: 0, v: { v: 'plain' } },
      ],
    }]
    const csv = buildCsv(data)
    const rows = csv.split('\n')
    // The hostile cell is neutralised (apostrophe-prefixed) — never a bare `=`.
    expect(rows[0].startsWith('=')).toBe(false)
    expect(csv).toContain("'=cmd")
    // The numeric cell is emitted verbatim as a number.
    expect(rows[0].split(',').pop()).toBe('-5')
    // Grid is rectangular (maxC=1) so the trailing empty column is an empty field.
    expect(rows[1]).toBe('plain,')
  })
})

/**
 * Round-trip fidelity (deep/office): the importer stores cell formulas (v.f),
 * column widths (config.columnlen) and row heights (config.rowlen) and its
 * docstring promises they round-trip — but the exporter previously wrote none of
 * them, so xlsx→edit→xlsx flattened every formula to its cached value and reset
 * all column/row sizes. These pin the fixed mapping via a real SheetJS round-trip.
 */
import * as XLSX from 'xlsx'
import { fortuneToWorksheet } from './sheetsExport.js'

describe('xlsx export — formula & dimension fidelity', () => {
  it('preserves a cell formula (not just its cached value)', () => {
    const ws = fortuneToWorksheet({
      name: 'S', config: {},
      celldata: [
        { r: 0, c: 0, v: { v: 5, ct: { t: 'n' } } },
        { r: 0, c: 1, v: { v: 10, ct: { t: 'n' } } },
        { r: 0, c: 2, v: { v: 15, f: '=A1+B1', ct: { t: 'n' } } },
      ],
    })
    // SheetJS wants the formula without a leading '='; the cached value is kept.
    // ws['C1'] hits WorkSheet's own [cell: string]: CellObject | WSKeys | any
    // index signature, which resolves to any by TS's rules — cast the read.
    expect((ws['C1'] as XLSX.CellObject).f).toBe('A1+B1') // was dropped → the cell became a static 15
    expect((ws['C1'] as XLSX.CellObject).v).toBe(15)
  })

  it('survives a real SheetJS write→read round-trip with the formula intact', () => {
    const ws = fortuneToWorksheet({
      name: 'S', config: {},
      celldata: [
        { r: 0, c: 0, v: { v: 5 } }, { r: 0, c: 1, v: { v: 10 } },
        { r: 0, c: 2, v: { v: 15, f: '=A1+B1' } },
      ],
    })
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'S')
    // XLSX.write()'s return is any in the library's own types — cast to
    // ArrayBuffer, documented as type: 'array''s real return.
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
    const re = XLSX.read(buf, { type: 'array' })
    expect((re.Sheets['S']['C1'] as XLSX.CellObject).f).toBe('A1+B1')
  })

  it('preserves column widths and row heights', () => {
    const ws = fortuneToWorksheet({
      name: 'S', config: { columnlen: { 0: 200 }, rowlen: { 0: 40 } },
      celldata: [{ r: 0, c: 0, v: { v: 'x' } }],
    })
    expect(ws['!cols']?.[0]?.wpx).toBe(200) // was undefined → default width
    expect(ws['!rows']?.[0]?.hpx).toBe(40)  // was undefined → default height
  })
})
