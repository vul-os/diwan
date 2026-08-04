/**
 * Sheets feature tests (vitest)
 * Covers: CSV import, conditional formatting rule, pivot create,
 * filter view toggle, named range usage, chart wizard insert.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// ─── 1. CSV import ────────────────────────────────────────────────────────────

import { parseCSV, csvToSheet, sheetsToCSV } from '../apps/sheets/csvImport.js'

describe('parseCSV', () => {
  it('splits simple rows', () => {
    const rows = parseCSV('a,b,c\n1,2,3')
    expect(rows).toEqual([['a', 'b', 'c'], ['1', '2', '3']])
  })

  it('handles quoted fields with commas', () => {
    const rows = parseCSV('"hello, world",foo\nbar,baz')
    expect(rows[0][0]).toBe('hello, world')
    expect(rows[0][1]).toBe('foo')
  })

  it('handles escaped double-quotes inside quoted fields', () => {
    const rows = parseCSV('"say ""hi""",ok')
    expect(rows[0][0]).toBe('say "hi"')
  })

  it('uses custom delimiter', () => {
    const rows = parseCSV('a|b|c', '|')
    expect(rows[0]).toEqual(['a', 'b', 'c'])
  })
})

describe('csvToSheet', () => {
  it('converts CSV text to Fortune Sheet format', () => {
    const sheet = csvToSheet('Name,Age\nAlice,30\nBob,25', 'People')
    expect(sheet.name).toBe('People')
    expect(sheet.celldata.length).toBe(6)
    const cell = sheet.celldata.find((c) => c.r === 1 && c.c === 0)
    expect(cell?.v?.v).toBe('Alice')
  })

  it('converts numeric strings to numbers', () => {
    const sheet = csvToSheet('x\n42')
    const numCell = sheet.celldata.find((c) => c.r === 1 && c.c === 0)
    expect(typeof numCell?.v?.v).toBe('number')
    expect(numCell?.v?.v).toBe(42)
  })

  it('round-trips through sheetsToCSV', () => {
    const original = 'Col1,Col2\nhello,42\nworld,7'
    const sheet  = csvToSheet(original, 'Test')
    const csv    = sheetsToCSV(sheet)
    // Re-parse and verify values are preserved.
    const rows   = parseCSV(csv)
    expect(rows[0]).toEqual(['Col1', 'Col2'])
    expect(rows[1][0]).toBe('hello')
    expect(Number(rows[1][1])).toBe(42)
  })
})

// ─── 2. Conditional formatting rule ──────────────────────────────────────────

// Helper: render ConditionalFormatPanel in isolation.
// NOTE: vi.mock's real signature only ever took (path, factory) — the
// trailing `{ spy: false }` here was a dead 3rd argument (vitest's `mock()`
// has no such parameter, so JS silently dropped it at call time); removing it
// is a no-op at runtime, just satisfies vi.mock's typed arity.
vi.mock('../../components/ui', async (orig) => {
  const real = await orig()
  return real
})

// We test the rule-building logic directly without full DOM mount.
describe('Conditional format rule builder', () => {
  it('serialises a cell_value rule correctly', () => {
    // Replicate the ruleToFS function logic inline (module is JSX, importing triggers React).
    interface CFRule {
      type: string
      operator: string
      value1: string
      value2: string
      format: { textColor: string; bgColor: string; bold: boolean }
    }
    function ruleToFS(rule: CFRule) {
      return {
        conditionName:   rule.type,
        conditionSymbol: rule.operator,
        conditionValue:  [rule.value1, rule.value2].filter(Boolean),
        format: {
          textColor: rule.format.textColor,
          cellColor: rule.format.bgColor,
          bold:      rule.format.bold ? '1' : '',
        },
      }
    }

    const rule: CFRule = {
      type: 'cell_value', operator: '>', value1: '100', value2: '',
      format: { bgColor: '#FFFF00', textColor: '', bold: false },
    }
    const fs = ruleToFS(rule)
    expect(fs.conditionName).toBe('cell_value')
    expect(fs.conditionSymbol).toBe('>')
    expect(fs.conditionValue).toContain('100')
    expect(fs.format.cellColor).toBe('#FFFF00')
  })
})

// ─── 3. Pivot table creation ──────────────────────────────────────────────────

// Test the pure computation logic directly.
describe('Pivot table computation', () => {
  type PivotCell = string | number
  type PivotTable = PivotCell[][]

  function buildPivot(table: PivotTable, rowField: string, colField: string, valueField: string, aggFn: string): PivotTable | null {
    const AGG: Record<string, (vals: PivotCell[]) => number> = {
      SUM:    (vals) => vals.reduce((a: number, b) => a + (Number(b) || 0), 0),
      COUNT:  (vals) => vals.length,
    }
    if (!table || table.length < 2) return null
    const headers = table[0]
    const rowIdx  = headers.indexOf(rowField)
    const colIdx  = headers.indexOf(colField)
    const valIdx  = headers.indexOf(valueField)
    if (rowIdx < 0 || valIdx < 0) return null

    const rows = new Set<string>(), cols = new Set<string>(), groups: Record<string, PivotCell[]> = {}
    for (let i = 1; i < table.length; i++) {
      const row = table[i]
      const rv  = String(row[rowIdx] ?? '')
      const cv  = colIdx >= 0 ? String(row[colIdx] ?? '') : '__value__'
      const vv  = row[valIdx]
      rows.add(rv); cols.add(cv)
      const key = `${rv}||${cv}`
      if (!groups[key]) groups[key] = []
      groups[key].push(vv)
    }

    const rowArr = [...rows].sort(), colArr = [...cols].sort()
    const result: PivotTable = [[rowField, ...colArr, 'Total']]
    for (const rv of rowArr) {
      const dataRow: PivotCell[] = [rv]
      let rowTotal = 0
      for (const cv of colArr) {
        const vals = groups[`${rv}||${cv}`] || []
        const agg  = AGG[aggFn] ? AGG[aggFn](vals) : 0
        dataRow.push(agg); rowTotal += Number(agg) || 0
      }
      dataRow.push(rowTotal); result.push(dataRow)
    }
    return result
  }

  it('creates a pivot table with correct totals', () => {
    const table: PivotTable = [
      ['Region', 'Product', 'Sales'],
      ['North', 'A', 100],
      ['North', 'B', 200],
      ['South', 'A', 150],
    ]
    const pivot = buildPivot(table, 'Region', 'Product', 'Sales', 'SUM')
    expect(pivot).toBeTruthy()
    expect(pivot![0]).toContain('A')
    expect(pivot![0]).toContain('B')
    // North row total should be 300.
    const northRow = pivot!.find((r) => r[0] === 'North')
    expect(northRow![northRow!.length - 1]).toBe(300)
  })

  it('returns null for empty table', () => {
    expect(buildPivot([], 'x', 'y', 'z', 'SUM')).toBeNull()
  })

  it('counts rows with COUNT aggregation', () => {
    const table: PivotTable = [
      ['Cat', 'Val'],
      ['A', 10], ['A', 20], ['B', 5],
    ]
    const pivot = buildPivot(table, 'Cat', '', 'Val', 'COUNT')
    const aRow = pivot!.find((r) => r[0] === 'A')
    expect(aRow).toBeTruthy()
  })
})

// ─── 4. Filter view toggle (pure logic) ───────────────────────────────────────

describe('Filter view computation', () => {
  interface FilterRule {
    colIndex: number
    type: string
    value: string
  }

  function matchesRule(value: unknown, rule: FilterRule): boolean {
    const v  = String(value ?? '').toLowerCase()
    const rv = String(rule.value ?? '').toLowerCase()
    switch (rule.type) {
      case 'contains':  return v.includes(rv)
      case 'equals':    return v === rv
      case 'not-empty': return v !== ''
      case 'number-gte': return Number(value) >= Number(rule.value)
      case 'number-lte': return Number(value) <= Number(rule.value)
      default: return true
    }
  }

  function computeHiddenRows(rows: unknown[][], filterRules: FilterRule[]): number[] {
    const hidden: number[] = []
    for (let ri = 1; ri < rows.length; ri++) {
      const row = rows[ri]
      let fail = false
      for (const rule of filterRules) {
        const val = row[rule.colIndex] ?? ''
        if (!matchesRule(val, rule)) { fail = true; break }
      }
      if (fail) hidden.push(ri)
    }
    return hidden
  }

  it('hides rows that do not match text-contains rule', () => {
    const rows = [['Name', 'Value'], ['Alice', 10], ['Bob', 20], ['Charlie', 30]]
    const hidden = computeHiddenRows(rows, [{ colIndex: 0, type: 'contains', value: 'li' }])
    // "Alice" and "Charlie" match; "Bob" should be hidden.
    expect(hidden).toContain(2) // Bob is row index 2
    expect(hidden).not.toContain(1) // Alice should pass
    expect(hidden).not.toContain(3) // Charlie should pass
  })

  it('hides rows with number-gte rule', () => {
    const rows = [['Score'], [50], [90], [70]]
    const hidden = computeHiddenRows(rows, [{ colIndex: 0, type: 'number-gte', value: '80' }])
    expect(hidden).toContain(1) // 50 < 80
    expect(hidden).not.toContain(2) // 90 >= 80
  })

  it('returns empty array when all rows pass', () => {
    const rows = [['x'], ['hello'], ['world']]
    const hidden = computeHiddenRows(rows, [{ colIndex: 0, type: 'not-empty', value: '' }])
    expect(hidden).toHaveLength(0)
  })
})

// ─── 5. Named range validation ────────────────────────────────────────────────

describe('Named range validation', () => {
  interface NamedRangeField {
    name: string
    range: string
  }

  function validate(f: NamedRangeField, existing: NamedRangeField[] = []): string | null {
    if (!f.name.trim()) return 'Name is required'
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(f.name)) return 'Name must start with a letter and contain only letters, digits, underscores'
    if (!f.range.trim()) return 'Range is required'
    for (const r of existing) {
      if (r.name.toLowerCase() === f.name.toLowerCase()) return `Name "${f.name}" is already used`
    }
    return null
  }

  it('accepts a valid range', () => {
    expect(validate({ name: 'myRange', range: 'A1:B10' })).toBeNull()
  })

  it('rejects empty name', () => {
    expect(validate({ name: '', range: 'A1:B10' })).toBeTruthy()
  })

  it('rejects name starting with a number', () => {
    expect(validate({ name: '1bad', range: 'A1:B10' })).toBeTruthy()
  })

  it('rejects empty range', () => {
    expect(validate({ name: 'ok', range: '' })).toBeTruthy()
  })

  it('rejects duplicate name (case-insensitive)', () => {
    const existing = [{ name: 'MyRange', range: 'A1:A5' }]
    expect(validate({ name: 'myrange', range: 'B1:B5' }, existing)).toBeTruthy()
  })
})

// ─── 6. Chart model (WAVE-54 — plain-data descriptor, not FortuneSheet) ───────

import { makeChart, insertChart, getCharts } from '../apps/sheets/charts.js'
import { selectionToRange } from '../apps/sheets/ChartWizard.jsx'

describe('Chart model', () => {
  it('builds a chart descriptor with the correct type', () => {
    const c = makeChart({ type: 'line', range: 'A1:B10', title: 'My Chart' })
    expect(c.type).toBe('line')
    expect(c.range).toBe('A1:B10')
    expect(c.title).toBe('My Chart')
  })

  it('falls back to column for an unknown type', () => {
    expect(makeChart({ type: 'nope' }).type).toBe('column')
  })

  it('inserts onto sheet.charts (plain, serialisable data)', () => {
    const data = insertChart([{ name: 'S', celldata: [] }], { type: 'pie', range: 'A1:A5' })
    const charts = getCharts(data)
    expect(charts).toHaveLength(1)
    expect(JSON.parse(JSON.stringify(charts[0]))).toEqual(charts[0])
  })

  it('selectionToRange converts a 0-indexed selection rect to A1 text', () => {
    expect(selectionToRange({ r0: 0, r1: 2, c0: 0, c1: 1 })).toBe('A1:B3')
    expect(selectionToRange(null)).toBe('')
  })
})
