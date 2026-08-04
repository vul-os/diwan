/**
 * colorScaleRender.test.js  (WAVE-64)
 *
 * The RENDER CONTRACT, asserted against Fortune-Sheet's REAL conditional-format
 * engine (its exported `compute()` — the exact function the canvas calls on every
 * draw), not against our reading of it.
 *
 * Every WAVE-64 rule kind is evaluated by US and handed to FS as a paint
 * instruction (`duplicateValue` + ['1'] over 1×1 rects — the only native
 * condition that colours a cell without inspecting it, and the only one that
 * colours a BLANK cell). If a Fortune-Sheet upgrade ever changes that branch,
 * these tests fail loudly instead of silently un-painting every rule.
 */
import { describe, it, expect } from 'vitest'
import { compute } from '@fortune-sheet/core'
import type { Context, CellMatrix } from '@fortune-sheet/core'
import { makeColorScale, buildNativeConditionFormat, type CSSheet, type CSCellEntry, type CSCellValue, type ColorScaleRule } from './colorScales.js'

// compute()'s ctx/d params are the real FortuneSheet Context/CellMatrix shapes
// (huge, mostly-required internal state); these fixtures are deliberately a
// tiny plain-data slice of them, cast through unknown the way production
// crosses sibling-module boundaries elsewhere (SheetsEditor.tsx's `cast<T>`).
function cast<T>(v: unknown): T { return v as T }

/** SHEET/withRules always carry row, column and celldata — flowdata() needs them. */
type FlowSheet = CSSheet & { row: number; column: number; celldata: CSCellEntry[] }

/** celldata → the dense 2-D `flowdata` array FS's compute() indexes. */
function flowdata(sheet: FlowSheet): CellMatrix {
  const d: (CSCellValue | null)[][] = Array.from({ length: sheet.row }, () => Array.from({ length: sheet.column }, () => null))
  for (const cell of sheet.celldata) d[cell.r][cell.c] = cell.v
  return cast<CellMatrix>(d)
}

const SHEET: FlowSheet = {
  name: 'Sheet1', row: 10, column: 5, config: {},
  celldata: [
    { r: 0, c: 0, v: { v: 5, m: '5', ct: { t: 'n' } } },
    { r: 1, c: 0, v: { v: 15, m: '15', ct: { t: 'n' } } },
    // A3 is deliberately NEVER WRITTEN (no celldata entry at all).
    { r: 3, c: 0, v: { v: 'dup', m: 'dup', ct: { t: 's' } } },
    { r: 4, c: 0, v: { v: 'dup', m: 'dup', ct: { t: 's' } } },
  ],
}
const withRules = (...rules: ColorScaleRule[]): FlowSheet => ({ ...SHEET, colorScales: rules })
const paint = (sheet: FlowSheet, ctx: unknown = {}) =>
  compute(cast<Context>(ctx), buildNativeConditionFormat(sheet, undefined), flowdata(sheet))

describe('FS compute() — single-colour rules paint exactly the matched cells', () => {
  it('greaterThan paints only the cell that beats the operand', () => {
    const map = paint(withRules(makeColorScale({ kind: 'greaterThan', range: 'A1:A5', value1: '10', fill: '#ff0000' })))
    expect(Object.keys(map)).toEqual(['1_0'])
    expect(map['1_0'].cellColor).toBe('#ff0000')
  })

  it('isEmpty paints a NEVER-WRITTEN cell — the case every other native condition skips', () => {
    const map = paint(withRules(makeColorScale({ kind: 'isEmpty', range: 'A1:A5', fill: '#00ff00' })))
    expect(Object.keys(map)).toEqual(['2_0'])
    expect(map['2_0'].cellColor).toBe('#00ff00')
  })

  it('duplicate paints every repeated value', () => {
    const map = paint(withRules(makeColorScale({ kind: 'duplicate', range: 'A1:A5', fill: '#0000ff' })))
    expect(Object.keys(map).sort()).toEqual(['3_0', '4_0'])
  })

  it('a custom-formula rule paints correctly AND leaves the sheet’s calcChain untouched', () => {
    // FS's own `formula` condition calls execfunction(), which pushes every CF cell
    // into file.calcChain — corrupting the model we then save. Ours cannot: the
    // formula is evaluated in our parser and FS only ever sees the paint primitive.
    const sheet = withRules(makeColorScale({ kind: 'formula', range: 'A1:A5', formula: '=$A1>10', fill: '#123456' }))
    const ctx = { luckysheetfile: [sheet], currentSheetId: undefined }
    const map = paint(sheet, ctx)
    expect(Object.keys(map)).toEqual(['1_0'])
    expect(map['1_0'].cellColor).toBe('#123456')
    expect(sheet.calcChain).toBeUndefined()
  })

  it('applies the rule’s text colour, and omits it when the rule keeps the cell’s own', () => {
    const withText = paint(withRules(makeColorScale({ kind: 'isNotEmpty', range: 'A1', fill: '#ffffff', textColor: '#b71c1c' })))
    expect(withText['0_0'].textColor).toBe('#b71c1c')
    const noText = paint(withRules(makeColorScale({ kind: 'isNotEmpty', range: 'A1', fill: '#ffffff', textColor: 'not-a-colour' })))
    expect(noText['0_0'].textColor).toBe('')
  })

  it('single-colour rules and gradients paint together, later rule winning', () => {
    const map = paint(withRules(
      makeColorScale({ kind: 'colorScale2', range: 'A1:A2', min: '#000000', max: '#000000' }),
      makeColorScale({ kind: 'textContains', range: 'A1:A5', value1: 'DUP', fill: '#abcdef' }),
      makeColorScale({ kind: 'greaterThan', range: 'A1:A5', value1: '10', fill: '#eeeeee' }),
    ))
    expect(map['3_0'].cellColor).toBe('#abcdef') // text rule
    expect(map['0_0'].cellColor).toMatch(/^#/)   // gradient band
    expect(map['1_0'].cellColor).toBe('#eeeeee') // the LAST rule wins over the band
  })

  it('a rule matching nothing paints nothing', () => {
    expect(paint(withRules(makeColorScale({ kind: 'greaterThan', range: 'A1:A5', value1: '999' })))).toEqual({})
  })

  it('a poisoned rule reaching the render path paints safely (or not at all) — never throws', () => {
    // Deliberately incomplete/hostile — never went through makeColorScale, which
    // is exactly what buildNativeConditionFormat's own re-clamp must catch.
    const sheet: FlowSheet = {
      ...SHEET,
      colorScales: cast<ColorScaleRule[]>([{ id: 'x', kind: 'isEmpty', range: 'A1:A99999', fill: 'url(javascript:alert(1))' }]),
    }
    let map: Record<string, { cellColor: string }> | undefined
    expect(() => { map = paint(sheet) }).not.toThrow() // an out-of-extent rect would throw inside FS
    for (const key of Object.keys(map!)) {
      expect(Number(key.split('_')[0])).toBeLessThan(SHEET.row)
      expect(map![key].cellColor).toMatch(/^#[0-9a-f]{3,6}$/)
    }
  })
})
