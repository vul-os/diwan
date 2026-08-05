/**
 * pivot.test.js  (WAVE-63)
 * Reactive pivot model: clamp/ingress validation, aggregation correctness,
 * live re-aggregation on source change, and CRDT-safety of the descriptor.
 */
import { describe, it, expect } from 'vitest'
import {
  makePivot, getPivots, insertPivot, updatePivot, deletePivot,
  clampPivots, computePivot, sourceTable, pivotHeaders, pivotValuesSignature,
  pivotText, PIVOT_AGGS,
  computePivotModel, pivotPercentColumns, pivotToSheet, dateBucket,
  type Pivot, type PivotAgg, type PivotSheet, type PivotGrouping,
} from './pivot.js'

// Build a FortuneSheet-style sheet from a 2-D array of display values.
function sheetFrom(grid: (string | number)[][]): PivotSheet {
  const celldata = []
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      const v = grid[r][c]
      if (v === '' || v == null) continue
      const isNum = typeof v === 'number'
      celldata.push({ r, c, v: { v, m: String(v), ct: { fa: 'General', t: isNum ? 'n' : 's' } } })
    }
  }
  return { name: 'Sheet1', celldata, config: {} }
}

const GRID: (string | number)[][] = [
  ['Region', 'Product', 'Sales'],
  ['East', 'Apple', 10],
  ['West', 'Apple', 20],
  ['East', 'Banana', 5],
  ['West', 'Banana', 15],
]

describe('makePivot — ingress clamp', () => {
  it('allow-lists agg, coerces + caps strings, normalises range', () => {
    const p = makePivot({ agg: 'EVIL', range: 'a1:d5', title: 42, rowField: 5, valueField: null })
    expect(p.agg).toBe('SUM')                 // unknown agg → default
    expect(p.range).toBe('A1:D5')             // upper-cased
    expect(p.title).toBe('')                  // non-string → ''
    expect(p.rowField).toBe('')               // non-string → ''
    expect(typeof p.id).toBe('string')
    // Serialisable = CRDT-safe.
    expect(JSON.parse(JSON.stringify(p))).toEqual(p)
  })
  it('preserves a valid id and every valid agg', () => {
    expect(makePivot({ id: 'pvt_x', agg: 'AVG' }).id).toBe('pvt_x')
    for (const a of PIVOT_AGGS) expect(makePivot({ agg: a }).agg).toBe(a)
  })
  it('caps absurdly long strings', () => {
    const p = makePivot({ title: 'x'.repeat(9999), rowField: 'y'.repeat(9999) })
    expect(p.title.length).toBeLessThanOrEqual(200)
    expect(p.rowField.length).toBeLessThanOrEqual(120)
  })
})

describe('pivotText — untrusted label safety', () => {
  it('neutralises formula/control chars', () => {
    expect(pivotText('=HYPERLINK("evil")')).toBe("'=HYPERLINK(\"evil\")")
    expect(pivotText('a\tb\nc')).toBe('a b c')
    expect(pivotText(123)).toBe('123')
  })
})

describe('immutable model ops', () => {
  it('insert / update / delete never mutate input', () => {
    const data = [sheetFrom(GRID)]
    const a = insertPivot(data, { range: 'A1:C5', rowField: 'Region', valueField: 'Sales' })
    expect(getPivots(a)).toHaveLength(1)
    expect(getPivots(data)).toHaveLength(0)
    const id = getPivots(a)[0].id
    const b = updatePivot(a, id, { agg: 'AVG' })
    expect(getPivots(b)[0].agg).toBe('AVG')
    expect(getPivots(a)[0].agg).toBe('SUM')
    const c = deletePivot(b, id)
    expect(getPivots(c)).toHaveLength(0)
  })
})

describe('computePivot — aggregation', () => {
  it('sums a value field grouped by row × column', () => {
    const sheet = sheetFrom(GRID)
    const pivot = makePivot({ range: 'A1:C5', rowField: 'Region', colField: 'Product', valueField: 'Sales', agg: 'SUM' })
    const res = computePivot(pivot, sheet)!
    // header: Region | Apple | Banana | Total
    expect(res[0]).toEqual(['Region', 'Apple', 'Banana', 'Total'])
    const east = res.find((r) => r[0] === 'East')
    const west = res.find((r) => r[0] === 'West')
    expect(east).toEqual(['East', 10, 5, 15])
    expect(west).toEqual(['West', 20, 15, 35])
    const total = res[res.length - 1]
    expect(total).toEqual(['Total', 30, 20, 50])
  })

  it('supports no column field (single value column)', () => {
    const sheet = sheetFrom(GRID)
    const pivot = makePivot({ range: 'A1:C5', rowField: 'Region', valueField: 'Sales', agg: 'SUM' })
    const res = computePivot(pivot, sheet)!
    expect(res[0]).toEqual(['Region', 'Sales', 'Total'])
    expect(res.find((r) => r[0] === 'East')).toEqual(['East', 15, 15])
    expect(res.find((r) => r[0] === 'West')).toEqual(['West', 35, 35])
  })

  it('AVG / COUNT / MAX / MIN aggregations', () => {
    const sheet = sheetFrom(GRID)
    const mk = (agg: PivotAgg) => computePivot(makePivot({ range: 'A1:C5', rowField: 'Region', valueField: 'Sales', agg }), sheet)!
    expect(mk('AVG').find((r) => r[0] === 'East')![1]).toBe(7.5)
    expect(mk('COUNT').find((r) => r[0] === 'East')![1]).toBe(2)
    expect(mk('MAX').find((r) => r[0] === 'West')![1]).toBe(20)
    expect(mk('MIN').find((r) => r[0] === 'West')![1]).toBe(15)
  })

  it('AVG ignores blank/non-numeric rows (denominator = numeric count)', () => {
    // East has 10, 5, and a blank Sales cell — AVG must be (10+5)/2 = 7.5, NOT 5.
    const grid: (string | number)[][] = [
      ['Region', 'Sales'],
      ['East', 10],
      ['East', 5],
      ['East', ''],   // blank value must not count toward the average
    ]
    const res = computePivot(makePivot({ range: 'A1:B4', rowField: 'Region', valueField: 'Sales', agg: 'AVG' }), sheetFrom(grid))!
    expect(res.find((r) => r[0] === 'East')![1]).toBe(7.5)
  })

  it('totals RE-AGGREGATE raw values (correct for AVG/MAX/MIN, not sum-of-subaggs)', () => {
    const sheet = sheetFrom(GRID)
    // AVG: East/Apple=10, East/Banana=5 → row total must be AVG(10,5)=7.5, not 15.
    const avg = computePivot(makePivot({ range: 'A1:C5', rowField: 'Region', colField: 'Product', valueField: 'Sales', agg: 'AVG' }), sheet)!
    expect(avg.find((r) => r[0] === 'East')!.at(-1)).toBe(7.5)
    // grand total AVG over all four sales (10,20,5,15) = 12.5
    expect(avg.at(-1)!.at(-1)).toBe(12.5)
    // MAX: East row total = MAX(10,5)=10 (not 15); grand MAX = 20.
    const max = computePivot(makePivot({ range: 'A1:C5', rowField: 'Region', colField: 'Product', valueField: 'Sales', agg: 'MAX' }), sheet)!
    expect(max.find((r) => r[0] === 'East')!.at(-1)).toBe(10)
    expect(max.at(-1)!.at(-1)).toBe(20)
  })

  it('returns null for missing fields / too-small source', () => {
    const sheet = sheetFrom(GRID)
    expect(computePivot(makePivot({ range: 'A1:C5', rowField: 'Nope', valueField: 'Sales' }), sheet)).toBeNull()
    expect(computePivot(makePivot({ range: 'A1:A1' }), sheet)).toBeNull()
  })
})

describe('LIVE re-aggregation (reactivity)', () => {
  it('recomputes when a source cell changes, and the signature changes with it', () => {
    const pivot = makePivot({ range: 'A1:C5', rowField: 'Region', valueField: 'Sales', agg: 'SUM' })
    const before = sheetFrom(GRID)
    const sigBefore = pivotValuesSignature(pivot, before)
    expect(computePivot(pivot, before)!.find((r) => r[0] === 'East')![1]).toBe(15)

    // Change East/Apple sales 10 → 100.
    const grid2 = GRID.map((row) => [...row])
    grid2[1][2] = 100
    const after = sheetFrom(grid2)
    const sigAfter = pivotValuesSignature(pivot, after)
    expect(sigAfter).not.toBe(sigBefore)                         // dep fingerprint moved
    expect(computePivot(pivot, after)!.find((r) => r[0] === 'East')![1]).toBe(105)
  })

  it('signature is stable when unrelated cells change', () => {
    const pivot = makePivot({ range: 'A1:C5', rowField: 'Region', valueField: 'Sales' })
    const sheet = sheetFrom(GRID)
    const sig1 = pivotValuesSignature(pivot, sheet)
    // Add a cell far outside the source range.
    const sheet2 = { ...sheet, celldata: [...sheet.celldata!, { r: 99, c: 99, v: { v: 'x', m: 'x', ct: { t: 's' } } }] }
    expect(pivotValuesSignature(pivot, sheet2)).toBe(sig1)
  })
})

describe('bounds / DoS safety', () => {
  it('a pathological range only materialises the sheet\'s populated extent', () => {
    // A1:ZZ999999 over a 5×3 sheet must NOT try to build a 10M-cell table — it
    // iterates only the used extent (5 rows, 3 cols). This is the DoS bound.
    const sheet = sheetFrom(GRID)
    const pivot = makePivot({ range: 'A1:ZZ999999', rowField: 'Region', valueField: 'Sales' })
    const t0 = Date.now()
    const table = sourceTable(pivot, sheet)
    expect(Date.now() - t0).toBeLessThan(200)      // fast, not iterating millions
    expect(table.length).toBe(5)
    expect(table[0].length).toBe(3)
    // And it still aggregates correctly within that extent.
    const res = computePivot(pivot, sheet)!
    expect(res.find((r) => r[0] === 'East')![1]).toBe(15)
  })
})

describe('clampPivots — defensive load clamp', () => {
  it('re-clamps corrupt local descriptors', () => {
    const data = [{ ...sheetFrom(GRID), pivots: [{ id: 'p1', agg: 'HACK', range: 'a1:c5' } as unknown as Pivot] }]
    const clamped = clampPivots(data)!
    expect(getPivots(clamped)[0].agg).toBe('SUM')
    expect(getPivots(clamped)[0].range).toBe('A1:C5')
  })
})

describe('pivotHeaders', () => {
  it('lists source header names', () => {
    expect(pivotHeaders(makePivot({ range: 'A1:C5' }), sheetFrom(GRID))).toEqual(['Region', 'Product', 'Sales'])
  })
})

// ── WAVE-64: multi-value, new aggregations, % displays, date grouping ────────

describe('WAVE-64 aggregations', () => {
  const grid: (string | number)[][] = [
    ['Grp', 'V'],
    ['a', 2], ['a', 4], ['a', 4], ['a', 5], ['a', 'text'], ['a', ''],
    ['b', 10],
  ]
  const sheet = sheetFrom(grid)
  const agg = (a: PivotAgg) => computePivot(makePivot({ range: 'A1:B8', rowField: 'Grp', valueField: 'V', agg: a }), sheet)!
    .find((r) => r[0] === 'a')![1]

  it('MEDIAN takes the middle of the sorted numeric values', () => {
    expect(agg('MEDIAN')).toBe(4)                       // 2,4,4,5 → (4+4)/2
    const odd = sheetFrom([['G', 'V'], ['a', 1], ['a', 100], ['a', 3]])
    expect(computePivot(makePivot({ range: 'A1:B4', rowField: 'G', valueField: 'V', agg: 'MEDIAN' }), odd)!
      .find((r) => r[0] === 'a')![1]).toBe(3)            // not the mean (34.67)
  })

  it('STDDEV is the SAMPLE standard deviation, and 0 (never NaN) for a single value', () => {
    // 2,4,4,5: mean 3.75; ss = 3.0625+0.0625+0.0625+1.5625 = 4.75; /3 → √1.5833
    expect(agg('STDDEV')).toBeCloseTo(1.258306, 5)
    expect(computePivot(makePivot({ range: 'A1:B8', rowField: 'Grp', valueField: 'V', agg: 'STDDEV' }), sheet)!
      .find((r) => r[0] === 'b')![1]).toBe(0)            // one sample → 0, not NaN
  })

  it('PRODUCT multiplies the numeric values (empty group → 0, not a silent 1)', () => {
    expect(agg('PRODUCT')).toBe(160)                    // 2*4*4*5
    const empty = sheetFrom([['G', 'V'], ['a', ''], ['a', 'x']])
    expect(computePivot(makePivot({ range: 'A1:B3', rowField: 'G', valueField: 'V', agg: 'PRODUCT' }), empty)!
      .find((r) => r[0] === 'a')![1]).toBe(0)
  })

  it('COUNTUNIQUE counts distinct non-blank values (text included)', () => {
    expect(agg('COUNTUNIQUE')).toBe(4)                  // 2, 4, 5, 'text' — blank excluded, 4 not double-counted
  })

  it('every new aggregation is allow-listed by the clamp', () => {
    for (const a of ['MEDIAN', 'STDDEV', 'PRODUCT', 'COUNTUNIQUE']) {
      expect(PIVOT_AGGS).toContain(a)
      expect(makePivot({ agg: a }).agg).toBe(a)
    }
    // …and anything else still falls back, fail-closed.
    for (const a of ['EVIL', '__proto__', 'eval', 1, {}, null]) {
      expect(makePivot({ agg: a }).agg).toBe('SUM')
    }
  })

  it('totals RE-AGGREGATE for the new functions too (no sum-of-medians)', () => {
    const g = sheetFrom([
      ['R', 'C', 'V'],
      ['x', 'p', 1], ['x', 'p', 3], ['x', 'q', 100],
    ])
    const res = computePivot(makePivot({ range: 'A1:C4', rowField: 'R', colField: 'C', valueField: 'V', agg: 'MEDIAN' }), g)!
    // Row total = MEDIAN(1,3,100) = 3 — NOT median(2,100)=51 or 2+100=102.
    expect(res.find((r) => r[0] === 'x')!.at(-1)).toBe(3)
  })
})

describe('WAVE-64 multiple value fields', () => {
  const grid: (string | number)[][] = [
    ['Region', 'Product', 'Sales', 'Units'],
    ['East', 'Apple', 10, 1],
    ['West', 'Apple', 20, 2],
    ['East', 'Banana', 5, 3],
    ['West', 'Banana', 15, 4],
  ]
  const sheet = sheetFrom(grid)

  it('emits one column per value field, each with its own aggregation', () => {
    const p = makePivot({
      range: 'A1:D5', rowField: 'Region',
      values: [
        { field: 'Sales', agg: 'SUM', display: 'raw' },
        { field: 'Units', agg: 'AVG', display: 'raw' },
      ],
    })
    const res = computePivot(p, sheet)!
    expect(res[0]).toEqual(['Region', 'Sales (SUM)', 'Units (AVG)', 'Total · Sales (SUM)', 'Total · Units (AVG)'])
    expect(res.find((r) => r[0] === 'East')).toEqual(['East', 15, 2, 15, 2])   // 10+5 ; (1+3)/2
    expect(res.find((r) => r[0] === 'West')).toEqual(['West', 35, 3, 35, 3])
    expect(res.at(-1)).toEqual(['Total', 50, 2.5, 50, 2.5])
  })

  it('crosses multiple values with a column field', () => {
    const p = makePivot({
      range: 'A1:D5', rowField: 'Region', colField: 'Product',
      values: [{ field: 'Sales', agg: 'SUM', display: 'raw' }, { field: 'Units', agg: 'SUM', display: 'raw' }],
    })
    const res = computePivot(p, sheet)!
    expect(res[0]).toEqual([
      'Region',
      'Apple · Sales (SUM)', 'Apple · Units (SUM)',
      'Banana · Sales (SUM)', 'Banana · Units (SUM)',
      'Total · Sales (SUM)', 'Total · Units (SUM)',
    ])
    expect(res.find((r) => r[0] === 'East')).toEqual(['East', 10, 1, 5, 3, 15, 4])
  })

  it('stays byte-compatible with the legacy single-value descriptor', () => {
    const legacy = makePivot({ range: 'A1:D5', rowField: 'Region', valueField: 'Sales', agg: 'SUM' })
    expect(legacy.values).toEqual([{ field: 'Sales', agg: 'SUM', display: 'raw' }])
    const res = computePivot(legacy, sheet)!
    expect(res[0]).toEqual(['Region', 'Sales', 'Total'])    // unchanged header shape
    expect(res.find((r) => r[0] === 'East')).toEqual(['East', 15, 15])
  })

  it('clamps the values list fail-closed (hostile CRDT peer)', () => {
    const p = makePivot({
      values: [
        { field: 'Sales', agg: 'EVIL', display: 'DROP TABLE' },   // bad agg + display → defaults
        { field: '', agg: 'SUM' },                                 // no field → dropped
        { agg: 'SUM' },                                            // no field → dropped
        { field: 'x'.repeat(999), agg: 'AVG', display: 'pct_row' },// capped
        ...Array.from({ length: 20 }, () => ({ field: 'F', agg: 'SUM', display: 'raw' })), // capped to 8
      ],
    })
    expect(p.values[0]).toEqual({ field: 'Sales', agg: 'SUM', display: 'raw' })
    expect(p.values.some((v) => v.field === '')).toBe(false)
    expect(p.values.length).toBeLessThanOrEqual(8)
    expect(p.values.find((v) => v.agg === 'AVG')!.field.length).toBeLessThanOrEqual(120)
    expect(JSON.parse(JSON.stringify(p))).toEqual(p)     // CRDT-safe plain data
    // values[0] is mirrored to the legacy pair so an OLD peer still sees a pivot.
    expect(p.valueField).toBe('Sales')
    expect(p.agg).toBe('SUM')
  })

  it('drops a value field that names a header the source does not have', () => {
    const p = makePivot({ range: 'A1:D5', rowField: 'Region', values: [{ field: 'Nope', agg: 'SUM', display: 'raw' }] })
    expect(computePivot(p, sheet)).toBeNull()            // nothing to aggregate → no table
  })
})

describe('WAVE-64 percentage displays', () => {
  const sheet = sheetFrom([
    ['Region', 'Product', 'Sales'],
    ['East', 'Apple', 10],
    ['West', 'Apple', 20],
    ['East', 'Banana', 5],
    ['West', 'Banana', 15],
  ])
  const pivot = (display: 'raw' | 'pct_total' | 'pct_row' | 'pct_col') => makePivot({
    range: 'A1:C5', rowField: 'Region', colField: 'Product',
    values: [{ field: 'Sales', agg: 'SUM', display }],
  })

  it('% of total divides by the grand total (50)', () => {
    const res = computePivot(pivot('pct_total'), sheet)!
    expect(res.find((r) => r[0] === 'East')).toEqual(['East', 20, 10, 30])   // 10/50, 5/50, 15/50
    expect(res.find((r) => r[0] === 'West')).toEqual(['West', 40, 30, 70])
    expect(res.at(-1)!.at(-1)).toBe(100)                                       // the whole table
  })

  it('% of row divides by the row total, so every row totals 100%', () => {
    const res = computePivot(pivot('pct_row'), sheet)!
    expect(res.find((r) => r[0] === 'East')).toEqual(['East', 66.666667, 33.333333, 100])
    expect(res.find((r) => r[0] === 'West')).toEqual(['West', 57.142857, 42.857143, 100])
  })

  it('% of column divides by the column total, so the total ROW is 100%', () => {
    const res = computePivot(pivot('pct_col'), sheet)!
    // Apple column = 30 → East 10/30, West 20/30. Banana = 20 → 5/20, 15/20.
    expect(res.find((r) => r[0] === 'East')).toEqual(['East', 33.333333, 25, 30])
    expect(res.at(-1)).toEqual(['Total', 100, 100, 100])
  })

  it('a zero denominator yields 0%, never NaN or Infinity', () => {
    const zeros = sheetFrom([['R', 'V'], ['a', 0], ['b', 0]])
    const res = computePivot(makePivot({
      range: 'A1:B3', rowField: 'R', values: [{ field: 'V', agg: 'SUM', display: 'pct_total' }],
    }), zeros)!
    for (const row of res.slice(1)) {
      for (const cell of row.slice(1)) {
        expect(Number.isFinite(cell)).toBe(true)
        expect(cell).toBe(0)
      }
    }
  })

  it('the model marks percentage columns so a renderer can show them as percentages', () => {
    const model = computePivotModel(pivot('pct_total'), sheet)!
    expect(model.displays[0]).toBeNull()                        // the row-label column
    expect(model.displays.slice(1).every((d) => d === 'pct_total')).toBe(true)
    expect([...pivotPercentColumns(model)]).toEqual([1, 2, 3])
    // A raw pivot marks nothing.
    expect(pivotPercentColumns(computePivotModel(pivot('raw'), sheet)).size).toBe(0)
  })

  it('the header names the display mode (a bare 33.33 next to sums would lie)', () => {
    const res = computePivot(makePivot({
      range: 'A1:C5', rowField: 'Region',
      values: [{ field: 'Sales', agg: 'SUM', display: 'pct_total' }],
    }), sheet)!
    expect(res[0][1]).toBe('Sales (% of total)')
  })

  it('percentages export with a percent number format, not a bare number', () => {
    const out = pivotToSheet(makePivot({
      range: 'A1:C5', rowField: 'Region',
      values: [{ field: 'Sales', agg: 'SUM', display: 'pct_row' }],
    }), sheet, 'P')!
    const pctCell = out.celldata.find((c) => c.r === 1 && c.c === 1)!
    expect(pctCell.v.ct.fa).toBe('0.00"%"')
    expect(typeof pctCell.v.v).toBe('number')
    // The row-label column is NOT formatted as a percentage.
    expect(out.celldata.find((c) => c.r === 1 && c.c === 0)!.v.ct.fa).toBe('General')
  })
})

describe('WAVE-64 date grouping', () => {
  const grid: (string | number)[][] = [
    ['Date', 'Sales'],
    ['2024-01-05', 1],
    ['2024-01-20', 2],
    ['2024-02-10', 4],
    ['2024-05-01', 8],
    ['2025-01-03', 16],
  ]
  const sheet = sheetFrom(grid)
  const byGroup = (rowGroup: PivotGrouping) => computePivot(
    makePivot({ range: 'A1:B6', rowField: 'Date', rowGroup, values: [{ field: 'Sales', agg: 'SUM', display: 'raw' }] }),
    sheet
  )!

  it('buckets by day / month / quarter / year', () => {
    expect(byGroup('year').slice(1, -1)).toEqual([['2024', 15, 15], ['2025', 16, 16]])
    expect(byGroup('quarter').slice(1, -1)).toEqual([['2024-Q1', 7, 7], ['2024-Q2', 8, 8], ['2025-Q1', 16, 16]])
    expect(byGroup('month').slice(1, -1)).toEqual([['2024-01', 3, 3], ['2024-02', 4, 4], ['2024-05', 8, 8], ['2025-01', 16, 16]])
    expect(byGroup('day')).toHaveLength(7)                       // header + 5 days + total
    expect(byGroup('none').slice(1, -1).map((r) => r[0])).toEqual([
      '2024-01-05', '2024-01-20', '2024-02-10', '2024-05-01', '2025-01-03',
    ])
  })

  it('buckets a DATE SERIAL (what a date-formatted cell actually stores)', () => {
    // Excel serials, 1899-12-30 epoch: 45298 = 2024-01-07, 45300 = 2024-01-09,
    // 45324 = 2024-02-02, 45658 = 2025-01-01.
    const serials = sheetFrom([['Date', 'V'], [45298, 1], [45300, 2], [45324, 4], [45658, 8]])
    const res = computePivot(makePivot({
      range: 'A1:B5', rowField: 'Date', rowGroup: 'month',
      values: [{ field: 'V', agg: 'SUM', display: 'raw' }],
    }), serials)!
    expect(res.slice(1, -1)).toEqual([['2024-01', 3, 3], ['2024-02', 4, 4], ['2025-01', 8, 8]])
    // …and the same serials grouped by year collapse to two rows.
    const byYear = computePivot(makePivot({
      range: 'A1:B5', rowField: 'Date', rowGroup: 'year',
      values: [{ field: 'V', agg: 'SUM', display: 'raw' }],
    }), serials)!
    expect(byYear.slice(1, -1)).toEqual([['2024', 7, 7], ['2025', 8, 8]])
  })

  it('is timezone-stable (buckets are computed in UTC)', () => {
    expect(dateBucket('2024-01-01', 'month')).toBe('2024-01')
    expect(dateBucket('2024-12-31', 'year')).toBe('2024')
    expect(dateBucket('2024-12-31T23:59:59Z', 'day')).toBe('2024-12-31')
  })

  it('a NON-date value is passed through unchanged, never swallowed into a wrong bucket', () => {
    expect(dateBucket('not a date', 'month')).toBe('not a date')
    expect(dateBucket('', 'year')).toBe('')
    expect(dateBucket(0, 'year')).toBe('0')          // 0 is not a date serial
    expect(dateBucket(null, 'day')).toBe('')
    // Mixed source: the text row keeps its own group instead of joining a date bucket.
    const mixed = sheetFrom([['D', 'V'], ['2024-01-05', 1], ['unknown', 2]])
    const res = computePivot(makePivot({
      range: 'A1:B3', rowField: 'D', rowGroup: 'month', values: [{ field: 'V', agg: 'SUM', display: 'raw' }],
    }), mixed)!
    expect(res.slice(1, -1).map((r) => r[0])).toEqual(['2024-01', 'unknown'])
  })

  it('groups the COLUMN field too', () => {
    const g = sheetFrom([
      ['R', 'D', 'V'],
      ['x', '2024-01-05', 1], ['x', '2024-02-05', 2], ['y', '2024-01-09', 4],
    ])
    const res = computePivot(makePivot({
      range: 'A1:C4', rowField: 'R', colField: 'D', colGroup: 'month',
      values: [{ field: 'V', agg: 'SUM', display: 'raw' }],
    }), g)!
    expect(res[0]).toEqual(['R', '2024-01', '2024-02', 'Total'])
    expect(res.find((r) => r[0] === 'x')).toEqual(['x', 1, 2, 3])
  })

  it('the grouping enum is allow-listed by the clamp', () => {
    for (const g of ['day', 'month', 'quarter', 'year', 'none']) {
      expect(makePivot({ rowGroup: g }).rowGroup).toBe(g)
      expect(makePivot({ colGroup: g }).colGroup).toBe(g)
    }
    for (const g of ['EVIL', '__proto__', 1, {}, null, 'века']) {
      expect(makePivot({ rowGroup: g }).rowGroup).toBe('none')
      expect(makePivot({ colGroup: g }).colGroup).toBe('none')
    }
  })

  it('the memo signature moves when the grouping or the values change', () => {
    const base = makePivot({ range: 'A1:B6', rowField: 'Date', values: [{ field: 'Sales', agg: 'SUM', display: 'raw' }] })
    const grouped = makePivot({ ...base, rowGroup: 'month' })
    const pct = makePivot({ ...base, values: [{ field: 'Sales', agg: 'SUM', display: 'pct_total' }] })
    expect(pivotValuesSignature(grouped, sheet)).not.toBe(pivotValuesSignature(base, sheet))
    expect(pivotValuesSignature(pct, sheet)).not.toBe(pivotValuesSignature(base, sheet))
  })
})
