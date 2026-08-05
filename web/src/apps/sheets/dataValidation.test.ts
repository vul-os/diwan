/**
 * dataValidation.test.js — unit tests for the data-validation rule helpers.
 */
import { describe, it, expect } from 'vitest'
import { parseRange } from './ConditionalFormatPanel.jsx'
import {
  dropdownItems,
  buildRegulation,
  numberConditionArity,
  validationSummary,
  cellKeysForRange,
  applyValidation,
  listValidationRules,
  type DVSheet,
} from './dataValidation.js'

describe('dropdownItems', () => {
  it('splits, trims, and drops empties', () => {
    expect(dropdownItems('Low, Medium , High')).toEqual(['Low', 'Medium', 'High'])
  })
  it('de-duplicates preserving order', () => {
    expect(dropdownItems('a, b, a, c, b')).toEqual(['a', 'b', 'c'])
  })
  it('empty → []', () => {
    expect(dropdownItems('')).toEqual([])
    expect(dropdownItems(null)).toEqual([])
    expect(dropdownItems('  , , ')).toEqual([])
  })
})

describe('numberConditionArity', () => {
  it('between/notBetween need 2', () => {
    expect(numberConditionArity('between')).toBe(2)
    expect(numberConditionArity('notBetween')).toBe(2)
  })
  it('single-value conditions need 1', () => {
    expect(numberConditionArity('equal')).toBe(1)
    expect(numberConditionArity('moreThanThe')).toBe(1)
    expect(numberConditionArity('unknown')).toBe(1)
  })
})

describe('buildRegulation', () => {
  it('dropdown → native shape', () => {
    const reg = buildRegulation({ kind: 'dropdown', items: 'x, y', allowMulti: false, rejectInvalid: true })
    expect(reg).toMatchObject({ type: 'dropdown', type2: '', value1: 'x,y', prohibitInput: true })
  })
  it('dropdown with multi sets type2="true"', () => {
    const reg = buildRegulation({ kind: 'dropdown', items: 'x,y', allowMulti: true })
    expect(reg!.type2).toBe('true')
  })
  it('dropdown with no items → null', () => {
    expect(buildRegulation({ kind: 'dropdown', items: '  ' })).toBeNull()
  })
  it('number between → both values, native type2', () => {
    const reg = buildRegulation({ kind: 'number', condition: 'between', value1: '1', value2: '10' })
    expect(reg).toMatchObject({ type: 'number', type2: 'between', value1: '1', value2: '10' })
  })
  it('number single-value drops value2', () => {
    const reg = buildRegulation({ kind: 'number', condition: 'moreThanThe', value1: '5', value2: '99' })
    expect(reg!.value1).toBe('5')
    expect(reg!.value2).toBe('')
  })
  it('number with non-numeric value → null', () => {
    expect(buildRegulation({ kind: 'number', condition: 'equal', value1: 'abc' })).toBeNull()
  })
  it('number between missing upper → null', () => {
    expect(buildRegulation({ kind: 'number', condition: 'between', value1: '1', value2: '' })).toBeNull()
  })
  it('unknown kind → null', () => {
    expect(buildRegulation({ kind: 'nope' })).toBeNull()
  })
})

describe('validationSummary', () => {
  it('dropdown summary counts items', () => {
    const reg = buildRegulation({ kind: 'dropdown', items: 'a,b,c' })
    expect(validationSummary(reg)).toBe('Dropdown · 3 items')
  })
  it('single-item dropdown is singular', () => {
    expect(validationSummary(buildRegulation({ kind: 'dropdown', items: 'a' }))).toBe('Dropdown · 1 item')
  })
  it('number between summary', () => {
    const reg = buildRegulation({ kind: 'number', condition: 'between', value1: '1', value2: '10' })
    expect(validationSummary(reg)).toBe('Number between 1 and 10')
  })
})

describe('cellKeysForRange', () => {
  it('enumerates inclusive rectangle in row-major order', () => {
    expect(cellKeysForRange([0, 1], [0, 1])).toEqual(['0_0', '0_1', '1_0', '1_1'])
  })
  it('caps runaway ranges', () => {
    expect(cellKeysForRange([0, 999], [0, 999], 5).length).toBe(5)
  })
})

describe('applyValidation / listValidationRules', () => {
  const base: DVSheet[] = [{ name: 'Sheet1', celldata: [], config: {} }]

  it('writes a rule across every cell in the range', () => {
    const reg = buildRegulation({ kind: 'dropdown', items: 'a,b' })
    const next = applyValidation(base, 'A1:A3', reg, parseRange)
    const dv = next[0].dataVerification!
    expect(Object.keys(dv).sort()).toEqual(['0_0', '1_0', '2_0'])
    expect((dv['0_0'] as { type: string }).type).toBe('dropdown')
  })

  it('is immutable — original sheet untouched', () => {
    const reg = buildRegulation({ kind: 'number', condition: 'equal', value1: '1' })
    applyValidation(base, 'A1', reg, parseRange)
    expect(base[0].dataVerification).toBeUndefined()
  })

  it('null regulation clears keys', () => {
    const reg = buildRegulation({ kind: 'dropdown', items: 'a,b' })
    const withRule = applyValidation(base, 'A1:A2', reg, parseRange)
    const cleared  = applyValidation(withRule, 'A1', null, parseRange)
    expect(cleared[0].dataVerification!['0_0']).toBeUndefined()
    expect(cleared[0].dataVerification!['1_0']).toBeDefined()
  })

  it('listValidationRules groups identical rules into one entry', () => {
    const reg = buildRegulation({ kind: 'dropdown', items: 'a,b' })
    const next = applyValidation(base, 'A1:A5', reg, parseRange)
    const rules = listValidationRules(next[0])
    expect(rules.length).toBe(1)
    expect(rules[0].count).toBe(5)
    expect(rules[0].summary).toBe('Dropdown · 2 items')
  })

  it('listValidationRules separates distinct rules', () => {
    let d = applyValidation(base, 'A1', buildRegulation({ kind: 'dropdown', items: 'a' }), parseRange)
    d = applyValidation(d, 'B1', buildRegulation({ kind: 'number', condition: 'equal', value1: '3' }), parseRange)
    expect(listValidationRules(d[0]).length).toBe(2)
  })
})
