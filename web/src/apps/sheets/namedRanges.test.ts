/**
 * namedRanges.test.js  (WAVE-63)
 * Named-range → formula-reference expansion: correctness, boundary safety,
 * string-literal safety, and injection safety.
 */
import { describe, it, expect } from 'vitest'
import { expandNamedRanges, getNamedRanges } from './namedRanges.js'

const defs = [
  { name: 'myRange', range: 'A1:B10', sheetName: 'Sheet1' },
  { name: 'tax', range: 'C1', sheetName: 'Sheet1' },
  { name: 'my', range: 'Z1', sheetName: 'Data Sheet' }, // prefix of myRange + quoted sheet
]

describe('expandNamedRanges', () => {
  it('expands a name to a Sheet!range reference', () => {
    expect(expandNamedRanges('=SUM(myRange)', defs)).toBe('=SUM(Sheet1!A1:B10)')
  })
  it('quotes sheet names that need it', () => {
    expect(expandNamedRanges('=my+1', defs)).toBe("='Data Sheet'!Z1+1")
  })
  it('is whole-identifier safe (prefix not partially matched)', () => {
    // "myRange" must win over "my" because longest-first; "myRangeExtra" untouched
    expect(expandNamedRanges('=myRange', defs)).toBe('=Sheet1!A1:B10')
    expect(expandNamedRanges('=myRangeExtra', defs)).toBe('=myRangeExtra')
  })
  it('never rewrites inside a string literal', () => {
    expect(expandNamedRanges('=CONCAT("myRange is tax", tax)', defs))
      .toBe('=CONCAT("myRange is tax", Sheet1!C1)')
  })
  it('does not touch an already-qualified reference', () => {
    expect(expandNamedRanges('=Sheet2!tax', defs)).toBe('=Sheet2!tax')
  })
  it('does not treat a function call of the same name as a range', () => {
    // `tax(` would be a function call, not the named range
    expect(expandNamedRanges('=tax(1)', defs)).toBe('=tax(1)')
  })
  it('leaves formulas with no matches unchanged (idempotent)', () => {
    expect(expandNamedRanges('=A1+B2', defs)).toBe('=A1+B2')
    expect(expandNamedRanges('=SUM(A1:A5)', [])).toBe('=SUM(A1:A5)')
  })
  it('handles doubled-quote escapes in string literals', () => {
    expect(expandNamedRanges('=CONCAT("say ""tax""", tax)', defs))
      .toBe('=CONCAT("say ""tax""", Sheet1!C1)')
  })
  it('ignores malformed definitions (injection guard)', () => {
    const bad = [{ name: 'a);DROP', range: 'A1', sheetName: 'S' }, { name: 'ok', range: 'B2', sheetName: 'S' }]
    // Malformed name is skipped; only the valid identifier expands.
    expect(expandNamedRanges('=ok', bad)).toBe('=S!B2')
    expect(expandNamedRanges('=ok', bad)).not.toContain('DROP')
  })
})

describe('getNamedRanges', () => {
  it('reads from first sheet, defaults to empty', () => {
    expect(getNamedRanges([{ namedRanges: defs }])).toBe(defs)
    expect(getNamedRanges([{}])).toEqual([])
    expect(getNamedRanges(null)).toEqual([])
  })
})
