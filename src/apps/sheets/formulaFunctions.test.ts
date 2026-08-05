/**
 * formulaFunctions.test.js  (WAVE-63)
 * Pure-function tests for the custom formula library: correct results, error
 * cases, and the parser-integration seam (install + live evaluate + recalc).
 */
import { describe, it, expect } from 'vitest'
import {
  TEXTJOIN, IFS, SWITCH, XLOOKUP, XMATCH, LET, FILTER, SORT, UNIQUE,
  TEXTBEFORE, TEXTAFTER, TEXTSPLIT, SEQUENCE, SORTBY,
  flatten, toBool, looseEqual, isErr, ERR, installCustomFormulas, CUSTOM_FUNCTIONS,
  type FormulaParserClass,
} from './formulaFunctions.js'

describe('helpers', () => {
  it('flatten handles scalar / 1-D / 2-D', () => {
    expect(flatten(5)).toEqual([5])
    expect(flatten([1, 2])).toEqual([1, 2])
    expect(flatten([[1, 2], [3, 4]])).toEqual([1, 2, 3, 4])
  })
  it('toBool spreadsheet semantics', () => {
    expect(toBool(true)).toBe(true)
    expect(toBool(0)).toBe(false)
    expect(toBool(1)).toBe(true)
    expect(toBool('TRUE')).toBe(true)
    expect(toBool('false')).toBe(false)
    expect(toBool('')).toBe(false)
  })
  it('looseEqual is number-aware + case-insensitive', () => {
    expect(looseEqual(5, '5')).toBe(true)
    expect(looseEqual('Foo', 'foo')).toBe(true)
    expect(looseEqual('a', 'b')).toBe(false)
    expect(looseEqual(null, 'x')).toBe(false)
  })
  it('isErr recognises sentinels', () => {
    expect(isErr('#N/A')).toBe(true)
    expect(isErr('#VALUE!')).toBe(true)
    expect(isErr('hello')).toBe(false)
  })
})

describe('TEXTJOIN', () => {
  it('joins with delimiter', () => {
    expect(TEXTJOIN(['-', 0, 'a', 'b', 'c'])).toBe('a-b-c')
  })
  it('ignore_empty skips blanks', () => {
    expect(TEXTJOIN([',', 1, 'a', '', 'b'])).toBe('a,b')
    expect(TEXTJOIN([',', 0, 'a', '', 'b'])).toBe('a,,b')
  })
  it('flattens ranges', () => {
    expect(TEXTJOIN([' ', 1, [['x', 'y'], ['z', '']]])).toBe('x y z')
  })
  it('propagates errors and guards arity', () => {
    expect(TEXTJOIN(['-', 1, ERR.VALUE])).toBe(ERR.VALUE)
    expect(TEXTJOIN(['-'])).toBe(ERR.NA)
  })
})

describe('IFS', () => {
  it('returns first true branch', () => {
    expect(IFS([false, 'a', true, 'b'])).toBe('b')
    expect(IFS([1 > 2, 'a', 3 > 1, 'b'])).toBe('b')
  })
  it('#N/A when nothing matches', () => {
    expect(IFS([false, 'a', false, 'b'])).toBe(ERR.NA)
  })
  it('propagates a condition error', () => {
    expect(IFS([ERR.DIV0, 'a'])).toBe(ERR.DIV0)
  })
})

describe('SWITCH', () => {
  it('matches a case', () => {
    expect(SWITCH([2, 1, 'one', 2, 'two', 3, 'three'])).toBe('two')
  })
  it('returns trailing default when unmatched', () => {
    expect(SWITCH([9, 1, 'one', 2, 'two', 'other'])).toBe('other')
  })
  it('#N/A when unmatched and no default', () => {
    expect(SWITCH([9, 1, 'one', 2, 'two'])).toBe(ERR.NA)
  })
})

describe('XLOOKUP', () => {
  const keys = [['apple'], ['banana'], ['cherry']]
  const vals = [[1], [2], [3]]
  it('exact match returns aligned value', () => {
    expect(XLOOKUP(['banana', keys, vals])).toBe(2)
  })
  it('if_not_found fallback', () => {
    expect(XLOOKUP(['durian', keys, vals, 'missing'])).toBe('missing')
    expect(XLOOKUP(['durian', keys, vals])).toBe(ERR.NA)
  })
  it('approximate next-smaller (-1)', () => {
    const nk = [[10], [20], [30]]
    const nv = [['a'], ['b'], ['c']]
    expect(XLOOKUP([25, nk, nv, 'x', -1])).toBe('b')
    expect(XLOOKUP([25, nk, nv, 'x', 1])).toBe('c')
  })
  it('guards arity', () => {
    expect(XLOOKUP(['x', keys])).toBe(ERR.NA)
  })
})

describe('XMATCH', () => {
  it('1-based position', () => {
    expect(XMATCH(['b', [['a'], ['b'], ['c']]])).toBe(2)
  })
  it('#N/A when absent', () => {
    expect(XMATCH(['z', [['a'], ['b']]])).toBe(ERR.NA)
  })
  it('approximate next-larger', () => {
    expect(XMATCH([15, [[10], [20], [30]], 1])).toBe(2)
  })
})

describe('LET — documented pure helper (NOT engine-wired; deferred)', () => {
  // LET is intentionally NOT in CUSTOM_FUNCTIONS: Fortune-Sheet's eager grammar
  // resolves the bare-name args as unknown variables and throws #NAME? before
  // the function runs. These tests only document the intended pure semantics.
  it('returns bound value when calc is the bound name', () => {
    expect(LET(['x', 42, 'x'])).toBe(42)
  })
  it('returns the computed final arg otherwise', () => {
    expect(LET(['x', 5, 'y', 10, 15])).toBe(15)
  })
  it('guards arity', () => {
    expect(LET(['x', 5])).toBe(ERR.NA)
  })
  it('is NOT registered into the live engine (honest about non-support)', () => {
    expect(CUSTOM_FUNCTIONS.LET).toBeUndefined()
  })
})

describe('FILTER (scalar-safe)', () => {
  it('keeps masked values', () => {
    expect(FILTER([[[1], [2], [3]], [[1], [0], [1]]])).toBe('1, 3')
  })
  it('single kept value returns scalar', () => {
    expect(FILTER([[[1], [2], [3]], [[0], [1], [0]]])).toBe(2)
  })
  it('if_empty when nothing passes', () => {
    expect(FILTER([[[1], [2]], [[0], [0]], 'none'])).toBe('none')
    expect(FILTER([[[1], [2]], [[0], [0]]])).toBe(ERR.NA)
  })
})

describe('SORT (scalar-safe)', () => {
  it('ascending by default, numbers before strings', () => {
    expect(SORT([[[3], [1], [2]]])).toBe('1, 2, 3')
  })
  it('descending order', () => {
    expect(SORT([[[3], [1], [2]], 1, -1])).toBe('3, 2, 1')
  })
  it('single value returns scalar', () => {
    expect(SORT([[[5]]])).toBe(5)
  })
})

describe('UNIQUE (scalar-safe)', () => {
  it('de-dupes preserving first-seen order', () => {
    expect(UNIQUE([[['a'], ['b'], ['a'], ['c']]])).toBe('a, b, c')
  })
  it('case-insensitive de-dupe', () => {
    expect(UNIQUE([[['Foo'], ['foo'], ['bar']]])).toBe('Foo, bar')
  })
  it('single value returns scalar', () => {
    expect(UNIQUE([[[7], [7]]])).toBe(7)
  })
})

describe('TEXTBEFORE / TEXTAFTER', () => {
  it('returns text before / after the first delimiter', () => {
    expect(TEXTBEFORE(['a-b-c', '-'])).toBe('a')
    expect(TEXTAFTER(['a-b-c', '-'])).toBe('b-c')
  })
  it('honors instance_num (positive and negative)', () => {
    expect(TEXTBEFORE(['a-b-c', '-', 2])).toBe('a-b')
    expect(TEXTAFTER(['a-b-c', '-', 2])).toBe('c')
    expect(TEXTBEFORE(['a-b-c', '-', -1])).toBe('a-b') // before the last
    expect(TEXTAFTER(['a-b-c', '-', -1])).toBe('c')     // after the last
  })
  it('case-insensitive match_mode=1', () => {
    expect(TEXTBEFORE(['aXbxc', 'x', 1, 1])).toBe('a')
  })
  it('missing delimiter → #N/A or if_not_found', () => {
    expect(TEXTBEFORE(['abc', '-'])).toBe(ERR.NA)
    expect(TEXTAFTER(['abc', '-', 1, 0, 0, 'none'])).toBe('none')
  })
  it('propagates an error argument', () => {
    expect(TEXTBEFORE([ERR.DIV0, '-'])).toBe(ERR.DIV0)
  })
})

describe('TEXTSPLIT (scalar-safe)', () => {
  it('splits on a delimiter; single field is scalar, many are comma-joined', () => {
    expect(TEXTSPLIT(['a,b,c', ','])).toBe('a, b, c')
    expect(TEXTSPLIT(['solo', ','])).toBe('solo')
  })
  it('ignore_empty drops empty fields', () => {
    expect(TEXTSPLIT(['a,,c', ',', undefined, true])).toBe('a, c')
    expect(TEXTSPLIT(['a,,c', ',', undefined, false])).toBe('a, , c')
  })
  it('a range of delimiters splits on any of them', () => {
    expect(TEXTSPLIT(['a,b;c', [[','], [';']]])).toBe('a, b, c')
  })
  it('missing delimiter → #VALUE!', () => {
    expect(TEXTSPLIT(['abc', ''])).toBe(ERR.VALUE)
  })
})

describe('SEQUENCE (scalar-safe, bounded)', () => {
  it('generates rows*cols values from start by step', () => {
    expect(SEQUENCE([4])).toBe('1, 2, 3, 4')
    expect(SEQUENCE([2, 2, 10, 5])).toBe('10, 15, 20, 25')
    expect(SEQUENCE([1])).toBe(1) // single value → scalar
  })
  it('rejects non-positive dims and an oversize total', () => {
    expect(SEQUENCE([0])).toBe(ERR.VALUE)
    expect(SEQUENCE([100000])).toBe(ERR.NUM)
  })
})

describe('SORTBY (scalar-safe)', () => {
  it('sorts an array by a companion array', () => {
    expect(SORTBY([['c', 'a', 'b'], [3, 1, 2]])).toBe('a, b, c')
    expect(SORTBY([['a', 'b', 'c'], [1, 2, 3], -1])).toBe('c, b, a')
  })
  it('length mismatch → #VALUE! (no silent misalignment)', () => {
    expect(SORTBY([['a', 'b', 'c'], [1, 2]])).toBe(ERR.VALUE)
  })
  it('propagates an error in either array', () => {
    expect(SORTBY([['a', ERR.NA], [1, 2]])).toBe(ERR.NA)
  })
})

// ── Parser integration seam ──────────────────────────────────────────────────
describe('installCustomFormulas seam', () => {
  it('registry covers every documented function', () => {
    for (const name of ['TEXTJOIN', 'IFS', 'SWITCH', 'XLOOKUP', 'XMATCH', 'FILTER', 'SORT', 'UNIQUE',
      'TEXTBEFORE', 'TEXTAFTER', 'TEXTSPLIT', 'SEQUENCE', 'SORTBY']) {
      expect(typeof CUSTOM_FUNCTIONS[name]).toBe('function')
    }
  })

  it('is idempotent and defers to built-ins', async () => {
    const FP = await import('@fortune-sheet/formula-parser')
    const ParserClass = FP.Parser as unknown as FormulaParserClass
    expect(installCustomFormulas(ParserClass)).toBe(true)
    expect(installCustomFormulas(ParserClass)).toBe(true) // second call = no-op
    const p = new FP.Parser()
    // Feed ranges the way FortuneSheet does (2-D arrays via callRangeValue).
    p.on('callRangeValue', (start, end, opts, done) => {
      // A1:A3 → keys, B1:B3 → values (col 0 vs col 1 by start label)
      if (start.column.index === 0) done([[1], [2], [3]])
      else done([['a'], ['b'], ['c']])
    })
    // Custom function resolves and evaluates live.
    expect(p.parse('XLOOKUP(2, A1:A3, B1:B3)').result).toBe('b')
    expect(p.parse('IFS(1>2, "x", 2>1, "y")').result).toBe('y')
    expect(p.parse('TEXTJOIN("-", 1, "a", "", "b")').result).toBe('a-b')
    expect(p.parse('SWITCH(2, 1, "one", 2, "two", "def")').result).toBe('two')
    // Newly-added custom functions resolve + evaluate LIVE through the engine.
    expect(p.parse('TEXTBEFORE("a-b-c", "-", 2)').result).toBe('a-b')
    expect(p.parse('TEXTAFTER("a-b-c", "-")').result).toBe('b-c')
    expect(p.parse('TEXTSPLIT("x,y,z", ",")').result).toBe('x, y, z')
    expect(p.parse('SEQUENCE(3)').result).toBe('1, 2, 3')
    // Built-in still works (not shadowed).
    expect(p.parse('SUM(1,2,3)').result).toBe(6)
    expect(p.parse('UPPER("hi")').result).toBe('HI')
    // A @formulajs built-in we deliberately do NOT own (REGEXMATCH) must STILL
    // resolve through the untouched fall-through — proving we never shadow it.
    expect(p.parse('REGEXMATCH("abc123", "[0-9]+")').result).toBe(true)
  })
})

describe('FILTER — error propagation is scoped to INCLUDED rows (deep/office)', () => {
  // FILTER takes ONE params array: [array, include, if_empty] (parser convention).
  it('an error in a FILTERED-OUT row does not corrupt the result', () => {
    // {10; #DIV/0!; 30} with mask {1;0;1} → the error is in the excluded row.
    // Excel/Sheets return {10, 30}; the bug returned #DIV/0! for the whole call.
    expect(FILTER([[[10], [ERR.DIV0], [30]], [[1], [0], [1]]])).toBe('10, 30')
  })
  it('an error in an INCLUDED row still propagates', () => {
    expect(FILTER([[[10], [ERR.DIV0], [30]], [[1], [1], [1]]])).toBe(ERR.DIV0)
  })
  it('an error in the INCLUDE mask propagates (not silently kept)', () => {
    expect(FILTER([[[10], [20]], [[ERR.NA], [1]]])).toBe(ERR.NA)
  })
  it('a mask SHORTER than the array errors instead of dropping the tail (deep/office2)', () => {
    // Was: FILTER({1;2;3}, {1;1}) → "1, 2" (row 3 silently dropped). Excel: #VALUE!.
    expect(FILTER([[[1], [2], [3]], [[1], [1]]])).toBe(ERR.VALUE)
  })
  it('a mask LONGER than the array errors too', () => {
    expect(FILTER([[[1], [2]], [[1], [1], [1]]])).toBe(ERR.VALUE)
  })
})

describe('XLOOKUP — row-aware 2-D return + length validation (deep/office2)', () => {
  it('a 2-D return range returns the matched ROW, not a flattened offset', () => {
    // Was: XLOOKUP("b", {a;b;c}, {10,11; 20,21; 30,31}) → 11 (row0,col1). Should be 20.
    expect(XLOOKUP(['b', [['a'], ['b'], ['c']], [[10, 11], [20, 21], [30, 31]]])).toBe(20)
  })
  it('a single-column return (flat or 1-col rows) is unchanged', () => {
    expect(XLOOKUP(['b', ['a', 'b', 'c'], [10, 20, 30]])).toBe(20)
    expect(XLOOKUP(['b', [['a'], ['b'], ['c']], [[10], [20], [30]]])).toBe(20)
  })
  it('a lookup/return length mismatch errors instead of misaligning', () => {
    // Was: XLOOKUP("a", {a;b;c}, {x;y}) → "x" silently. Excel: #VALUE!.
    expect(XLOOKUP(['a', ['a', 'b', 'c'], ['x', 'y']])).toBe(ERR.VALUE)
  })
  it('approximate match still resolves through the row picker', () => {
    expect(XLOOKUP([25, [10, 20, 30], [1, 2, 3], null, -1])).toBe(2)
  })
})
