/**
 * xlsxChartsRead.test.js — the pure halves of the OOXML chart reader, and the
 * clamps that keep an untrusted file from reaching the renderer.
 *
 * The end-to-end contract (a real foreign .xlsx in, real charts out, real bytes
 * back) lives in __tests__/xlsxRoundTrip.test.js. This file pins the decisions the
 * reader makes on the way there — above all the ones where it must REFUSE. A chart
 * our descriptor cannot express has to be reported, never approximated: quietly
 * plotting a rectangle that happens to contain the user's series (plus a column
 * they never charted) would be a worse bug than the silent drop we set out to fix.
 */
import { describe, it, expect } from 'vitest'
import { parseRef, chartTypeOf, rangeFromSeries, geometryOf, type ParsedRef } from './xlsxChartsRead.js'
import {
  makeImportNotes, hasImportLoss, combineImportNotes, importLossSummary,
  getImportNotes, setImportNotes, mergeImportNotes,
} from './importNotes.js'

// A tiny XML → element helper so the type tests read like the markup they parse.
const el = (xml: string): Element => new DOMParser().parseFromString(xml, 'text/xml').documentElement
const groups = (...xmls: string[]): Element[] => xmls.map(el)

describe('parseRef', () => {
  it('reads a plain range', () => {
    expect(parseRef('Sheet1!$B$2:$B$9')).toEqual({ sheet: 'Sheet1', r0: 1, r1: 8, c0: 1, c1: 1 })
  })
  it('reads a single cell (a series-name reference)', () => {
    expect(parseRef('Sales!$B$1')).toEqual({ sheet: 'Sales', r0: 0, r1: 0, c0: 1, c1: 1 })
  })
  it('reads a quoted sheet name with spaces and an escaped quote', () => {
    expect(parseRef("'My Sheet'!$A$1:$C$3")!.sheet).toBe('My Sheet')
    expect(parseRef("'It''s'!$A$1")!.sheet).toBe("It's")
  })
  it('handles multi-letter columns', () => {
    expect(parseRef('S!$AA$1:$AB$2')).toMatchObject({ c0: 26, c1: 27 })
  })
  it('normalises a reversed range', () => {
    expect(parseRef('S!$C$9:$A$2')).toMatchObject({ r0: 1, r1: 8, c0: 0, c1: 2 })
  })
  it('REFUSES what it cannot be sure of, rather than guessing', () => {
    expect(parseRef('Sheet1:Sheet3!$A$1')).toBeNull()   // 3-D range
    expect(parseRef('SUM(A1:A2)')).toBeNull()           // a formula
    expect(parseRef('TableName[Col]')).toBeNull()       // structured reference
    expect(parseRef('Sheet1!$A:$A')).toBeNull()         // whole column
    expect(parseRef('')).toBeNull()
    expect(parseRef(null)).toBeNull()
  })
})

describe('chartTypeOf', () => {
  const bar = (dir: string, grouping: string) =>
    `<barChart xmlns="x"><barDir val="${dir}"/><grouping val="${grouping}"/><ser/></barChart>`

  it('maps the bar/column family, including stacking', () => {
    expect(chartTypeOf(groups(bar('col', 'clustered')))).toEqual({ type: 'column' })
    expect(chartTypeOf(groups(bar('bar', 'clustered')))).toEqual({ type: 'bar' })
    expect(chartTypeOf(groups(bar('col', 'stacked')))).toEqual({ type: 'column-stacked' })
    expect(chartTypeOf(groups(bar('bar', 'stacked')))).toEqual({ type: 'bar-stacked' })
    expect(chartTypeOf(groups(bar('col', 'percentStacked')))).toEqual({ type: 'column-100' })
    expect(chartTypeOf(groups(bar('bar', 'percentStacked')))).toEqual({ type: 'bar-100' })
  })

  it('maps the rest of the family', () => {
    expect(chartTypeOf(groups('<lineChart xmlns="x"/>'))).toEqual({ type: 'line' })
    expect(chartTypeOf(groups('<areaChart xmlns="x"/>'))).toEqual({ type: 'area' })
    expect(chartTypeOf(groups('<pieChart xmlns="x"/>'))).toEqual({ type: 'pie' })
    expect(chartTypeOf(groups('<doughnutChart xmlns="x"/>'))).toEqual({ type: 'donut' })
    expect(chartTypeOf(groups('<scatterChart xmlns="x"/>'))).toEqual({ type: 'scatter' })
    expect(chartTypeOf(groups('<bubbleChart xmlns="x"/>'))).toEqual({ type: 'bubble' })
  })

  it('reads a bar+line pair as our combo (columns first, then lines)', () => {
    expect(chartTypeOf(groups(bar('col', 'clustered'), '<lineChart xmlns="x"><ser/></lineChart>')))
      .toEqual({ type: 'combo' })
  })

  it('will not pretend an unmappable plot is a column chart', () => {
    expect(chartTypeOf(groups('<radarChart xmlns="x"/>')).error).toMatch(/radar/i)
    expect(chartTypeOf(groups('<surfaceChart xmlns="x"/>')).error).toMatch(/surface/i)
    expect(chartTypeOf(groups('<stockChart xmlns="x"/>')).error).toMatch(/stock/i)
    expect(chartTypeOf([]).error).toBeTruthy()
    // A combo we render as "first series columns, rest lines" — a two-column-series
    // combo would misplot, so it is refused rather than reshaped.
    const twoBarSers = '<barChart xmlns="x"><barDir val="col"/><ser/><ser/></barChart>'
    expect(chartTypeOf(groups(twoBarSers, '<lineChart xmlns="x"><ser/></lineChart>')).error)
      .toMatch(/more than one column series/i)
  })
})

describe('rangeFromSeries — folding cell references back into one contiguous range', () => {
  const ref = (sheet: string, r0: number, c0: number, r1: number, c1: number): ParsedRef => ({ sheet, r0, c0, r1, c1 })

  it('categories + one series, with a header row', () => {
    const series = [{
      val: ref('S', 1, 1, 4, 1),      // B2:B5
      cat: ref('S', 1, 0, 4, 0),      // A2:A5
      tx:  ref('S', 0, 1, 0, 1),      // B1
    }]
    expect(rangeFromSeries(series, 'S')).toEqual({ range: 'A1:B5', headerRow: true, headerCol: true })
  })

  it('two contiguous series → one range spanning both value columns', () => {
    const series = [
      { val: ref('S', 1, 1, 4, 1), cat: ref('S', 1, 0, 4, 0), tx: ref('S', 0, 1, 0, 1) },
      { val: ref('S', 1, 2, 4, 2), cat: ref('S', 1, 0, 4, 0), tx: ref('S', 0, 2, 0, 2) },
    ]
    expect(rangeFromSeries(series, 'S')).toEqual({ range: 'A1:C5', headerRow: true, headerCol: true })
  })

  it('no series names → no header row (the range starts at the data)', () => {
    const series = [{ val: ref('S', 1, 1, 4, 1), cat: ref('S', 1, 0, 4, 0), tx: null }]
    expect(rangeFromSeries(series, 'S')).toEqual({ range: 'A2:B5', headerRow: false, headerCol: true })
  })

  it('no categories → no header column', () => {
    const series = [{ val: ref('S', 1, 1, 4, 1), cat: null, tx: ref('S', 0, 1, 0, 1) }]
    expect(rangeFromSeries(series, 'S')).toEqual({ range: 'B1:B5', headerRow: true, headerCol: false })
  })

  it('REFUSES every shape our single-rectangle range would misrepresent', () => {
    const cat = ref('S', 1, 0, 4, 0)
    // A gap between series columns: the enclosing rectangle would silently add the
    // column in between as a series the user never plotted.
    expect(rangeFromSeries([
      { val: ref('S', 1, 1, 4, 1), cat, tx: null },
      { val: ref('S', 1, 3, 4, 3), cat, tx: null },
    ], 'S').error).toMatch(/non-adjacent/i)

    // Category labels detached from the data (cats in A, series in C).
    expect(rangeFromSeries([{ val: ref('S', 1, 2, 4, 2), cat, tx: null }], 'S').error)
      .toMatch(/not next to the data/i)

    // Series laid out across rows — our renderer reads columns as series.
    expect(rangeFromSeries([{ val: ref('S', 1, 1, 1, 5), cat: null, tx: null }], 'S').error)
      .toMatch(/across rows/i)

    // Data on another worksheet: our charts read the first sheet's cells.
    expect(rangeFromSeries([{ val: ref('Other', 1, 1, 4, 1), cat: null, tx: null }], 'S').error)
      .toMatch(/another sheet/i)

    // Series pulled from more than one sheet.
    expect(rangeFromSeries([
      { val: ref('S', 1, 1, 4, 1), cat: null, tx: null },
      { val: ref('T', 1, 2, 4, 2), cat: null, tx: null },
    ], 'S').error).toMatch(/more than one sheet/i)

    // Series covering different row spans.
    expect(rangeFromSeries([
      { val: ref('S', 1, 1, 4, 1), cat: null, tx: null },
      { val: ref('S', 1, 2, 9, 2), cat: null, tx: null },
    ], 'S').error).toMatch(/different rows/i)

    expect(rangeFromSeries([], 'S').error).toBeTruthy()
    expect(rangeFromSeries([{ val: null, cat: null, tx: null }], 'S').error).toBeTruthy()
  })
})

describe('geometryOf — drawing anchors → pixels', () => {
  it('reads a oneCellAnchor (from + extent)', () => {
    const anchor = el(
      '<oneCellAnchor xmlns="x">' +
      '<from><col>7</col><colOff>0</colOff><row>1</row><rowOff>0</rowOff></from>' +
      '<ext cx="5400000" cy="2700000"/></oneCellAnchor>'
    )
    // 9525 EMU per px; col 7 × 64px, row 1 × 20px.
    expect(geometryOf(anchor)).toEqual({ x: 448, y: 20, w: 567, h: 283 })
  })

  it('reads a twoCellAnchor (from + to)', () => {
    const anchor = el(
      '<twoCellAnchor xmlns="x">' +
      '<from><col>1</col><colOff>0</colOff><row>1</row><rowOff>0</rowOff></from>' +
      '<to><col>9</col><colOff>0</colOff><row>16</row><rowOff>0</rowOff></to></twoCellAnchor>'
    )
    expect(geometryOf(anchor)).toEqual({ x: 64, y: 20, w: 512, h: 300 })
  })

  it('returns null when there is nothing to read (placement falls back to defaults)', () => {
    expect(geometryOf(el('<twoCellAnchor xmlns="x"/>'))).toBeNull()
  })
})

describe('importNotes — the record of what an import could not bring in', () => {
  it('is null when nothing was lost, so a clean file keeps its zero-friction export', () => {
    expect(makeImportNotes(null)).toBeNull()
    expect(makeImportNotes({ pivots: 0, charts: [] })).toBeNull()
    expect(hasImportLoss(null)).toBe(false)
  })

  it('clamps an untrusted record (it rides inside saved file content)', () => {
    const notes = makeImportNotes({
      pivots: -5,
      charts: [{ title: 'x'.repeat(500), reason: 'y'.repeat(500) }, { title: 42, reason: null }],
      filename: 'f.xlsx',
    })!
    expect(notes.pivots).toBe(0)
    expect(notes.charts[0].title).toHaveLength(160)
    expect(notes.charts[0].reason).toHaveLength(160)
    expect(notes.charts[1].title).toBe('')                       // non-string coerced away
    expect(notes.charts[1].reason).toBe('it could not be represented')
  })

  it('bounds the list a hostile file could grow', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ title: `c${i}`, reason: 'nope' }))
    expect(makeImportNotes({ charts: many })!.charts).toHaveLength(20)
  })

  it('survives the FortuneSheet normalisation that drops app-owned fields', () => {
    const notes = makeImportNotes({ pivots: 2, charts: [], filename: 'a.xlsx' })
    const data = setImportNotes([{ name: 'S', celldata: [] }], notes)
    expect(getImportNotes(data)!.pivots).toBe(2)

    // FortuneSheet re-emits sheets WITHOUT sheet.importNotes — exactly what happens
    // on the first keystroke after an import. Without the merge, the export warning
    // would vanish precisely when the user is about to overwrite their file.
    const normalised = [{ name: 'S', celldata: [{ r: 0, c: 0, v: { v: 1 } }] }]
    expect(getImportNotes(normalised)).toBeNull()
    expect(getImportNotes(mergeImportNotes(normalised, notes))!.pivots).toBe(2)
  })

  it('combines the losses of several imports into one workbook', () => {
    const a = makeImportNotes({ pivots: 1, charts: [{ title: 'A', reason: 'r' }], filename: 'a.xlsx' })
    const b = makeImportNotes({ pivots: 2, charts: [{ title: 'B', reason: 'r' }], filename: 'b.xlsx' })
    const c = combineImportNotes(a, b)!
    expect(c.pivots).toBe(3)
    expect(c.charts.map((x) => x.title)).toEqual(['A', 'B'])
    expect(c.filename).toBeUndefined()                           // no single file to blame
    expect(combineImportNotes(null, b)).toEqual(b)
    expect(combineImportNotes(a, null)).toEqual(a)
  })

  it('says it in plain English', () => {
    expect(importLossSummary(makeImportNotes({ pivots: 1 })))
      .toMatch(/1 pivot table came in as plain cells.*not.*live pivot.*export from here will not contain them/i)
    expect(importLossSummary(makeImportNotes({ charts: [{ title: 'A', reason: 'r' }] })))
      .toMatch(/1 chart could not be imported/i)
    expect(importLossSummary(null)).toBe('')
  })
})
