/**
 * colorScaleRules.test.js  (WAVE-64)
 *
 * The single-colour conditional-format rules — cell value, text, date, empty,
 * duplicate and custom formula. Covers, for every kind:
 *   • correct evaluation (matchCells / computeColorScale),
 *   • the fail-closed ingress clamp REJECTING a malformed/hostile descriptor,
 *   • the native paint instruction handed to the canvas (bounded, hex-only,
 *     never carrying a user string into Fortune-Sheet's model).
 */
import { describe, it, expect } from 'vitest'
import {
  makeColorScale, getColorScales, clampColorScales,
  computeColorScale, computeAllColorScales, colorScaleSignature,
  safeOptionalColor, safeText, CS_KINDS, CS_SINGLE_KINDS,
  toNativeConditionFormat, toNativeSingleColor, buildNativeConditionFormat,
  matchCells, colorScaleError, colorScaleSummary, isSingleKind, parseDay, cellString,
  type CSSheet, type CSCellEntry, type CSCellObject, type ColorScaleRule, type PaintBg,
} from './colorScales.js'

// A handful of hostile/near-miss fixtures below deliberately never pass through
// makeColorScale (that IS the render-boundary re-clamp under test), so they
// don't structurally match ColorScaleRule; cast through unknown at those call
// sites, the same way production crosses sibling-module boundaries elsewhere.
function cast<T>(v: unknown): T { return v as T }

type MixedSheet = CSSheet & { row: number; column: number; celldata: CSCellEntry[] }

// A sheet of mixed content: numbers, text, dates, blanks.
function mixedSheet(cells: Record<string, string | number | CSCellObject>): MixedSheet {
  const celldata: CSCellEntry[] = Object.entries(cells).map(([k, v]) => {
    const [r, c] = k.split('_').map(Number)
    if (v && typeof v === 'object') return { r, c, v }
    const t = typeof v === 'number' ? 'n' : 's'
    return { r, c, v: { v, m: String(v), ct: { fa: 'General', t } } }
  })
  return { name: 'Sheet1', celldata, config: {}, row: 100, column: 26 }
}
const dateCell = (serial: number, display: string): CSCellObject => ({ v: serial, m: display, ct: { fa: 'yyyy-MM-dd', t: 'd' } })
const keys = (matches: { r: number; c: number }[]) => matches.map(({ r, c }) => `${r}_${c}`)

describe('matchCells — numeric cell-value rules', () => {
  const sheet = mixedSheet({ '0_0': 5, '1_0': 10, '2_0': 15, '3_0': 'abc', '4_0': '9' })

  it('greaterThan / lessThan compare NUMERICALLY (not as strings)', () => {
    // The string "9" must NOT beat 10 — Fortune-Sheet's own greaterThan lets it.
    expect(keys(matchCells(makeColorScale({ kind: 'greaterThan', range: 'A1:A5', value1: '10' }), sheet))).toEqual(['2_0'])
    expect(keys(matchCells(makeColorScale({ kind: 'lessThan', range: 'A1:A5', value1: '10' }), sheet))).toEqual(['0_0', '4_0'])
  })
  it('greaterOrEqual / lessOrEqual include the boundary', () => {
    expect(keys(matchCells(makeColorScale({ kind: 'greaterOrEqual', range: 'A1:A5', value1: '10' }), sheet))).toEqual(['1_0', '2_0'])
    expect(keys(matchCells(makeColorScale({ kind: 'lessOrEqual', range: 'A1:A5', value1: '10' }), sheet))).toEqual(['0_0', '1_0', '4_0'])
  })
  it('between / notBetween are inclusive and order-insensitive', () => {
    expect(keys(matchCells(makeColorScale({ kind: 'between', range: 'A1:A5', value1: '10', value2: '5' }), sheet)))
      .toEqual(['0_0', '1_0', '4_0'])
    expect(keys(matchCells(makeColorScale({ kind: 'notBetween', range: 'A1:A5', value1: '5', value2: '10' }), sheet))).toEqual(['2_0'])
  })
  it('equalTo / notEqualTo compare numerically when both sides are numbers, else as text', () => {
    expect(keys(matchCells(makeColorScale({ kind: 'equalTo', range: 'A1:A5', value1: '9' }), sheet))).toEqual(['4_0'])
    expect(keys(matchCells(makeColorScale({ kind: 'equalTo', range: 'A1:A5', value1: 'ABC' }), sheet))).toEqual(['3_0'])
    expect(keys(matchCells(makeColorScale({ kind: 'notEqualTo', range: 'A1:A5', value1: '10' }), sheet)))
      .toEqual(['0_0', '2_0', '3_0', '4_0'])
  })
  it('a rule with a missing/non-numeric operand matches NOTHING (never everything)', () => {
    expect(matchCells(makeColorScale({ kind: 'greaterThan', range: 'A1:A5', value1: 'not-a-number' }), sheet)).toEqual([])
    expect(matchCells(makeColorScale({ kind: 'between', range: 'A1:A5', value1: '1' }), sheet)).toEqual([]) // no value2
  })
})

describe('matchCells — text rules', () => {
  const sheet = mixedSheet({ '0_0': 'Hello World', '1_0': 'goodbye', '2_0': 'hello', '3_0': 42 })

  it('contains / does not contain (case-insensitive; a blank cell matches neither)', () => {
    expect(keys(matchCells(makeColorScale({ kind: 'textContains', range: 'A1:A5', value1: 'HELLO' }), sheet)))
      .toEqual(['0_0', '2_0'])
    expect(keys(matchCells(makeColorScale({ kind: 'textNotContains', range: 'A1:A5', value1: 'hello' }), sheet)))
      .toEqual(['1_0', '3_0'])
  })
  it('starts with / ends with / is exactly', () => {
    expect(keys(matchCells(makeColorScale({ kind: 'textStartsWith', range: 'A1:A4', value1: 'hello' }), sheet)))
      .toEqual(['0_0', '2_0'])
    expect(keys(matchCells(makeColorScale({ kind: 'textEndsWith', range: 'A1:A4', value1: 'world' }), sheet))).toEqual(['0_0'])
    expect(keys(matchCells(makeColorScale({ kind: 'textExactly', range: 'A1:A4', value1: 'Hello' }), sheet))).toEqual(['2_0'])
  })
  it('an empty operand matches NOTHING (an unfinished rule must not paint the range)', () => {
    expect(matchCells(makeColorScale({ kind: 'textContains', range: 'A1:A4', value1: '' }), sheet)).toEqual([])
  })
})

describe('matchCells — date rules', () => {
  // 45000 = 2023-03-15 on the Excel serial-day axis; the others are date strings.
  const sheet = mixedSheet({
    '0_0': dateCell(45000, '2023-03-15'),
    '1_0': '2026-07-14',
    '2_0': '2026-07-01',
    '3_0': '2026-06-30',
    '4_0': 'not a date',
  })
  const now = new Date(2026, 6, 14) // Tue 14 Jul 2026, local

  it('reads BOTH a native date cell (Excel serial) and an ISO date string', () => {
    expect(keys(matchCells(makeColorScale({ kind: 'dateBefore', range: 'A1:A5', value1: '2026-01-01' }), sheet, now)))
      .toEqual(['0_0'])
    expect(keys(matchCells(makeColorScale({ kind: 'dateAfter', range: 'A1:A5', value1: '2026-07-01' }), sheet, now)))
      .toEqual(['1_0'])
  })
  it('today / this week / this month are relative to now', () => {
    expect(keys(matchCells(makeColorScale({ kind: 'dateToday', range: 'A1:A5' }), sheet, now))).toEqual(['1_0'])
    // The week starts Sunday 2026-07-12 → only 07-14 falls inside it.
    expect(keys(matchCells(makeColorScale({ kind: 'dateThisWeek', range: 'A1:A5' }), sheet, now))).toEqual(['1_0'])
    // July 2026 → 07-14 and 07-01, but not 06-30.
    expect(keys(matchCells(makeColorScale({ kind: 'dateThisMonth', range: 'A1:A5' }), sheet, now))).toEqual(['1_0', '2_0'])
  })
  it('a malformed date operand matches NOTHING', () => {
    expect(matchCells(makeColorScale({ kind: 'dateBefore', range: 'A1:A5', value1: '2026-13-45' }), sheet, now)).toEqual([])
    expect(matchCells(makeColorScale({ kind: 'dateAfter', range: 'A1:A5', value1: 'yesterday' }), sheet, now)).toEqual([])
  })
  it('parseDay rejects impossible calendar dates', () => {
    expect(parseDay('2024-02-29')).toBeGreaterThan(0) // leap year — a real day
    expect(Number.isNaN(parseDay('2023-02-29'))).toBe(true)
    expect(Number.isNaN(parseDay('nope'))).toBe(true)
  })
})

describe('matchCells — empty / not empty / duplicate', () => {
  const sheet = mixedSheet({ '0_0': 'a', '1_0': 'A', '2_0': 'b', '4_0': '   ' })

  it('isEmpty matches never-written cells AND whitespace-only cells', () => {
    expect(keys(matchCells(makeColorScale({ kind: 'isEmpty', range: 'A1:A5' }), sheet))).toEqual(['3_0', '4_0'])
  })
  it('isNotEmpty is its exact complement', () => {
    expect(keys(matchCells(makeColorScale({ kind: 'isNotEmpty', range: 'A1:A5' }), sheet))).toEqual(['0_0', '1_0', '2_0'])
  })
  it('duplicate matches repeated values case-insensitively, ignoring blanks', () => {
    expect(keys(matchCells(makeColorScale({ kind: 'duplicate', range: 'A1:A5' }), sheet))).toEqual(['0_0', '1_0'])
  })
})

describe('matchCells — custom formula (our own parser, once per cell)', () => {
  const sheet = mixedSheet({ '0_0': 5, '0_1': 1, '1_0': 20, '1_1': 2, '2_0': 5, '2_1': 3 })

  it('anchors relative refs to the range origin, as Sheets does', () => {
    const rule = makeColorScale({ kind: 'formula', range: 'A1:B3', formula: '=$A1>10' })
    // Row 2 (A2 = 20) matches → BOTH of its columns are painted.
    expect(keys(matchCells(rule, sheet))).toEqual(['1_0', '1_1'])
  })
  it('resolves absolute refs and range functions', () => {
    const rule = makeColorScale({ kind: 'formula', range: 'A1:A3', formula: '=COUNTIF($A$1:$A$3,A1)>1' })
    expect(keys(matchCells(rule, sheet))).toEqual(['0_0', '2_0'])
  })
  it('a bad formula (syntax, unknown function, empty) matches nothing and never throws', () => {
    for (const f of ['=)(*&^%$', '=NOPE(1)', '=A1>', '']) {
      const rule = makeColorScale({ kind: 'formula', range: 'A1:B3', formula: f })
      expect(() => matchCells(rule, sheet)).not.toThrow()
      expect(matchCells(rule, sheet)).toEqual([])
    }
  })
  it('a non-boolean truthy result counts as a match (spreadsheet semantics)', () => {
    expect(keys(matchCells(makeColorScale({ kind: 'formula', range: 'A1', formula: '=1' }), sheet))).toEqual(['0_0'])
    expect(matchCells(makeColorScale({ kind: 'formula', range: 'A1', formula: '=0' }), sheet)).toEqual([])
  })
})

describe('matchCells — bounds', () => {
  it('never addresses a cell outside the grid extent', () => {
    // Fortune-Sheet's duplicateValue compute dereferences data[r][c] with no bounds
    // check — an out-of-extent rect would throw inside the canvas draw.
    const sheet = mixedSheet({ '0_0': 1 }) // 100 rows × 26 cols
    const m = matchCells(makeColorScale({ kind: 'isEmpty', range: 'A1:A500' }), sheet)
    expect(m.length).toBeGreaterThan(0)
    expect(Math.max(...m.map((x) => x.r))).toBeLessThan(100)
  })
  it('an over-large area is dropped rather than scanned', () => {
    const sheet = { ...mixedSheet({ '0_0': 1 }), row: 5000, column: 100 }
    expect(matchCells(makeColorScale({ kind: 'isNotEmpty', range: 'A1:CV5000' }), sheet)).toEqual([])
  })
})

describe('computeColorScale — single-colour paint map', () => {
  it('paints ONLY the matched cells, in the rule’s validated colours', () => {
    const sheet = mixedSheet({ '0_0': 5, '1_0': 15 })
    const m = computeColorScale(
      makeColorScale({ kind: 'greaterThan', range: 'A1:A2', value1: '10', fill: '#00FF00', textColor: '#FFFFFF' }),
      sheet,
    )
    expect(m).toEqual({ '1_0': { bg: '#00ff00', fg: '#ffffff' } })
  })
  it('a hostile colour never reaches the paint map', () => {
    const sheet = mixedSheet({ '0_0': 15 })
    const m = computeColorScale(
      makeColorScale({ kind: 'greaterThan', range: 'A1', value1: '10', fill: 'url(javascript:alert(1))', textColor: 'expression(x)' }),
      sheet,
    )
    expect(cast<PaintBg>(m['0_0']).bg).toMatch(/^#[0-9a-f]{3,6}$/)
    expect(cast<PaintBg>(m['0_0']).fg).toBe('') // unusable text colour → keep the cell's own
  })
  it('computeAllColorScales re-clamps every rule (no render path reads a raw descriptor)', () => {
    const sheet = mixedSheet({ '0_0': 15 })
    const merged = computeAllColorScales(
      [{ id: 'x', kind: 'greaterThan', range: 'A1', value1: '10', fill: 'javascript:x' }],
      sheet,
    )
    expect(cast<PaintBg>(merged['0_0']).bg).toMatch(/^#[0-9a-f]{3,6}$/)
  })
})

describe('toNativeSingleColor — the canvas paint instruction', () => {
  const sheet = mixedSheet({ '0_0': 5, '1_0': 15, '2_0': 25 })

  it('emits ONE rule whose cellrange is exactly the matched cells, as 1×1 rects', () => {
    const nat = toNativeSingleColor(makeColorScale({ kind: 'greaterThan', range: 'A1:A3', value1: '10', fill: '#ff0000' }), sheet)
    expect(nat).toHaveLength(1)
    expect(nat[0].cellrange).toEqual([
      { row: [1, 1], column: [0, 0] },
      { row: [2, 2], column: [0, 0] },
    ])
    // duplicateValue + '1' = "colour the values occurring once in this range"; over a
    // 1×1 range that is unconditionally the cell itself — the only native condition
    // that paints a cell without inspecting it (and the only one that paints BLANKS).
    expect(nat[0].conditionName).toBe('duplicateValue')
    expect(nat[0].conditionValue).toEqual(['1'])
  })
  it('never emits the native `formula` condition (it would corrupt the sheet’s calcChain)', () => {
    const nat = toNativeSingleColor(makeColorScale({ kind: 'formula', range: 'A1:A3', formula: '=A1>10' }), sheet)
    expect(nat).toHaveLength(1)
    expect(nat[0].conditionName).toBe('duplicateValue')
    expect(JSON.stringify(nat)).not.toContain('A1>10') // the user string never crosses into FS
  })
  it('emits validated hex colours and integer rects only', () => {
    const nat = toNativeSingleColor(
      makeColorScale({ kind: 'isNotEmpty', range: 'A1:A3', fill: 'url(x)', textColor: 'javascript:1' }),
      sheet,
    )
    expect(nat[0].format.cellColor).toMatch(/^#[0-9a-f]{3,6}$/)
    expect(nat[0].format.textColor).toBe('')
    for (const rect of nat[0].cellrange) {
      expect(Number.isInteger(rect.row[0])).toBe(true)
      expect(Number.isInteger(rect.column[0])).toBe(true)
      expect(rect.row[0]).toBeGreaterThanOrEqual(0)
    }
  })
  it('a rule that matches nothing emits nothing', () => {
    expect(toNativeSingleColor(makeColorScale({ kind: 'greaterThan', range: 'A1:A3', value1: '999' }), sheet)).toEqual([])
  })
  it('toNativeConditionFormat routes single-colour kinds through it', () => {
    const nat = toNativeConditionFormat(makeColorScale({ kind: 'lessThan', range: 'A1:A3', value1: '10' }), sheet, undefined)
    expect(nat).toHaveLength(1)
    expect(nat[0].cellrange).toEqual([{ row: [0, 0], column: [0, 0] }])
  })
})

describe('buildNativeConditionFormat — re-clamps at the render boundary', () => {
  it('a poisoned rule that reached sheet.colorScales cannot reach the canvas unclamped', () => {
    const sheet: MixedSheet = {
      ...mixedSheet({ '0_0': 15 }),
      // Never went through makeColorScale: near-miss kind, hostile colour, object
      // operand — cast, since that's exactly the gap buildNativeConditionFormat's
      // re-clamp is under test for.
      colorScales: cast<ColorScaleRule[]>([{
        id: 'x', kind: 'formula ', range: 'A1',
        fill: 'url(javascript:alert(1))', textColor: 'expression(1)',
        value1: { toString: () => 'boom' },
      }]),
    }
    const merged = buildNativeConditionFormat(sheet, undefined)
    for (const rule of merged) {
      expect(['between', 'duplicateValue']).toContain(rule.conditionName)
      expect(rule.format.cellColor).toMatch(/^#[0-9a-f]{3,6}$/)
    }
    const json = JSON.stringify(merged)
    expect(json).not.toContain('javascript')
    expect(json).not.toContain('expression')
    expect(json).not.toContain('boom')
  })
  it('single-colour rules and gradients render side by side, in rule order', () => {
    const sheet: MixedSheet = {
      ...mixedSheet({ '0_0': 1, '1_0': 2, '2_0': 3 }),
      colorScales: [
        makeColorScale({ kind: 'colorScale2', range: 'A1:A3' }),
        makeColorScale({ kind: 'greaterThan', range: 'A1:A3', value1: '2', fill: '#ff0000' }),
      ],
    }
    const merged = buildNativeConditionFormat(sheet, undefined)
    expect(merged.filter((r) => r.conditionName === 'between').length).toBeGreaterThan(1) // gradient bands
    const single = merged.filter((r) => r.conditionName === 'duplicateValue')
    expect(single).toHaveLength(1)
    expect(merged.indexOf(single[0])).toBe(merged.length - 1) // the later rule wins
  })
})

describe('makeColorScale — WAVE-64 ingress clamp (hostile descriptors)', () => {
  it('allow-lists every new kind and defaults anything else', () => {
    for (const k of CS_SINGLE_KINDS) expect(makeColorScale({ kind: k }).kind).toBe(k)
    expect(makeColorScale({ kind: 'formula ' }).kind).toBe('colorScale2') // no fuzzy matching
    expect(makeColorScale({ kind: 'isEmpty ' }).kind).toBe('colorScale2')
    expect(makeColorScale({ kind: ['isEmpty'] }).kind).toBe('colorScale2')
    expect(makeColorScale({ kind: null }).kind).toBe('colorScale2')
  })
  it('rejects hostile colours on the single-colour fields', () => {
    const r = makeColorScale({ kind: 'greaterThan', fill: 'url(javascript:alert(1))', textColor: 'expression(x)' })
    expect(r.fill).toMatch(/^#[0-9a-f]{3,6}$/)
    expect(r.textColor).toBe('')
    expect(makeColorScale({ kind: 'greaterThan', textColor: '#ABC' }).textColor).toBe('#abc')
  })
  it('coerces operands to bounded, control-char-free plain strings', () => {
    const r = makeColorScale({
      kind: 'textContains',
      value1: 'a\u0001b\u007fc',
      value2: { toString: () => 'evil' },
      formula: '='.padEnd(5000, 'A'),
    })
    expect(r.value1).toBe('abc')          // control characters stripped
    expect(r.value2).toBe('')             // an object operand is dropped, never stringified
    expect(r.formula.length).toBeLessThanOrEqual(300)
    expect(JSON.parse(JSON.stringify(r))).toEqual(r) // CRDT-safe plain data
  })
  it('caps operand length', () => {
    expect(makeColorScale({ kind: 'textContains', value1: 'x'.repeat(500) }).value1.length).toBe(120)
  })
  it('clampColorScales re-clamps a corrupt single-colour rule from a loaded file', () => {
    const data: MixedSheet[] = [{
      ...mixedSheet({ '0_0': 1 }),
      // Corrupt/legacy record (wrong types on several fields) — never went
      // through makeColorScale; that's exactly what clampColorScales re-clamps.
      colorScales: cast<ColorScaleRule[]>([{ id: 'x', kind: 'EVIL', range: 'a1:b2', fill: 'red', textColor: 'url(x)', value1: 5, formula: 42 }]),
    }]
    const [rule] = getColorScales(clampColorScales(data))
    expect(rule.kind).toBe('colorScale2')
    expect(rule.range).toBe('A1:B2')
    expect(rule.fill).toMatch(/^#/)
    expect(rule.textColor).toBe('')
    expect(rule.value1).toBe('5')   // a numeric operand is legitimate — coerced, not dropped
    expect(rule.formula).toBe('42')
  })
  it('safeText / safeOptionalColor guard the primitives directly', () => {
    expect(safeText(null)).toBe('')
    expect(safeText(undefined)).toBe('')
    expect(safeText([1, 2])).toBe('')
    expect(safeText(7)).toBe('7')
    expect(safeOptionalColor(undefined)).toBe('')
    expect(safeOptionalColor('rgb(1,2,3)')).toBe('')
    expect(safeOptionalColor('#112233')).toBe('#112233')
  })
})

describe('colorScaleError — the panel’s save gate', () => {
  it('rejects an unusable range or operand, accepts a complete rule', () => {
    expect(colorScaleError(makeColorScale({ kind: 'greaterThan', range: 'nope', value1: '1' }))).toMatch(/range/i)
    expect(colorScaleError(makeColorScale({ kind: 'greaterThan', range: 'A1', value1: '' }))).toMatch(/number/i)
    expect(colorScaleError(makeColorScale({ kind: 'between', range: 'A1', value1: '1', value2: '' }))).toMatch(/both/i)
    expect(colorScaleError(makeColorScale({ kind: 'textContains', range: 'A1', value1: '' }))).toMatch(/text/i)
    expect(colorScaleError(makeColorScale({ kind: 'dateBefore', range: 'A1', value1: 'soon' }))).toMatch(/date/i)
    expect(colorScaleError(makeColorScale({ kind: 'formula', range: 'A1', formula: '' }))).toMatch(/formula/i)
    expect(colorScaleError(makeColorScale({ kind: 'greaterThan', range: 'A1:A9', value1: '10' }))).toBeNull()
    expect(colorScaleError(makeColorScale({ kind: 'isEmpty', range: 'A1:A9' }))).toBeNull()
    expect(colorScaleError(makeColorScale({ kind: 'colorScale3', range: 'A1:A9' }))).toBeNull()
  })
  it('every registered kind has a summary and a known family', () => {
    for (const k of CS_KINDS) {
      const rule = makeColorScale({ kind: k, range: 'A1', value1: '1', value2: '2', formula: '=A1' })
      expect(colorScaleSummary(rule)).toBeTruthy()
      expect(typeof isSingleKind(k)).toBe('boolean')
    }
  })
})

describe('reactivity signature — single-colour rules', () => {
  it('changes when a TEXT value changes (a numeric-only fingerprint would miss it)', () => {
    const rule = makeColorScale({ kind: 'textContains', range: 'A1:A2', value1: 'x' })
    expect(colorScaleSignature(rule, mixedSheet({ '0_0': 'abc' })))
      .not.toBe(colorScaleSignature(rule, mixedSheet({ '0_0': 'abd' })))
  })
  it('changes when the rule’s own operand changes', () => {
    const sheet = mixedSheet({ '0_0': 5 })
    expect(colorScaleSignature(makeColorScale({ kind: 'greaterThan', range: 'A1', value1: '1' }), sheet))
      .not.toBe(colorScaleSignature(makeColorScale({ kind: 'greaterThan', range: 'A1', value1: '2' }), sheet))
  })
  it('a formula rule fingerprints the whole sheet (it may read any cell)', () => {
    const rule = makeColorScale({ kind: 'formula', range: 'A1', formula: '=$Z$1>0' })
    expect(colorScaleSignature(rule, mixedSheet({ '0_0': 1, '0_25': 1 })))
      .not.toBe(colorScaleSignature(rule, mixedSheet({ '0_0': 1, '0_25': 2 })))
  })
  it('cellString reads a date cell’s display form', () => {
    // cellString only ever reads `.v` (see colorScales.ts); r/c are irrelevant here.
    expect(cellString(cast<CSCellEntry>({ v: dateCell(45000, '2023-03-15') }))).toBe('2023-03-15')
    expect(cellString(undefined)).toBe('')
  })
})
