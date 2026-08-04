/**
 * conditionalFormat.test.js — unit tests for the parseRange A1-notation parser
 * in ConditionalFormatPanel.jsx.
 */
import { describe, it, expect } from 'vitest'
import { colLetterToIndex, parseCellRef, parseRange } from './ConditionalFormatPanel.jsx'

describe('colLetterToIndex', () => {
  it('A=0', () => expect(colLetterToIndex('A')).toBe(0))
  it('Z=25', () => expect(colLetterToIndex('Z')).toBe(25))
  it('AA=26', () => expect(colLetterToIndex('AA')).toBe(26))
  it('AZ=51', () => expect(colLetterToIndex('AZ')).toBe(51))
  it('BA=52', () => expect(colLetterToIndex('BA')).toBe(52))
  it('case-insensitive', () => expect(colLetterToIndex('a')).toBe(0))
})

describe('parseCellRef', () => {
  it('A1 → row 0, col 0', () => expect(parseCellRef('A1')).toEqual({ row: 0, col: 0 }))
  it('B2 → row 1, col 1', () => expect(parseCellRef('B2')).toEqual({ row: 1, col: 1 }))
  it('Z100 → row 99, col 25', () => expect(parseCellRef('Z100')).toEqual({ row: 99, col: 25 }))
  it('invalid → null', () => expect(parseCellRef('foo')).toBeNull())
})

describe('parseRange', () => {
  it('empty string → fallback', () => {
    expect(parseRange('')).toEqual([{ row: [0, 99], column: [0, 25] }])
  })

  it('null → fallback', () => {
    // parseRange's runtime `!text` guard handles null defensively even though
    // its declared type is `string`; exercise that guard via a cast, not a type hole.
    expect(parseRange(null as unknown as string)).toEqual([{ row: [0, 99], column: [0, 25] }])
  })

  it('single cell B2 → row [1,1] col [1,1]', () => {
    expect(parseRange('B2')).toEqual([{ row: [1, 1], column: [1, 1] }])
  })

  it('A1:Z100 → row [0,99] col [0,25]', () => {
    expect(parseRange('A1:Z100')).toEqual([{ row: [0, 99], column: [0, 25] }])
  })

  it('A1:B10 → row [0,9] col [0,1]', () => {
    expect(parseRange('A1:B10')).toEqual([{ row: [0, 9], column: [0, 1] }])
  })

  it('normalises reversed range (end < start)', () => {
    // Z100:A1 should produce the same as A1:Z100
    expect(parseRange('Z100:A1')).toEqual([{ row: [0, 99], column: [0, 25] }])
  })

  it('invalid text → fallback', () => {
    expect(parseRange('garbage')).toEqual([{ row: [0, 99], column: [0, 25] }])
  })

  it('case-insensitive: a1:z100', () => {
    expect(parseRange('a1:z100')).toEqual([{ row: [0, 99], column: [0, 25] }])
  })
})
