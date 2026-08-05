/**
 * dataValidationKinds.test.js  (WAVE-64)
 *
 * The data-validation kinds beyond dropdown+number — range-sourced dropdowns
 * (incl. cross-sheet), checkboxes, dates, text content and text length. Covers,
 * for every kind: the native regulation it builds, the round-trip back into the
 * panel's form, the human summary, and the FAIL-CLOSED clamp rejecting a
 * malformed/hostile regulation on ingress.
 */
import { describe, it, expect } from 'vitest'
import { parseRange } from './ConditionalFormatPanel.jsx'
import {
  VALIDATION_KINDS, DATE_CONDITIONS, TEXT_CONDITIONS,
  dateConditionArity, validationRange, validationDate,
  buildRegulation, validationSummary, regulationToForm,
  clampRegulation, clampDataValidation,
  applyValidation, listValidationRules,
  type DVSheet,
} from './dataValidation.js'

// parseRange (ConditionalFormatPanel.jsx, not yet converted) infers a `number[]`
// row/column shape rather than the `[number, number]` tuple applyValidation's
// signature declares — a local, typed adapter over the same runtime contract.
const parseRangeTyped = (text: string): { row: [number, number]; column: [number, number] }[] | undefined =>
  parseRange(text) as { row: [number, number]; column: [number, number] }[] | undefined

describe('validationRange — the dropdown source-range gate', () => {
  it('accepts A1 ranges, $-anchors and a sheet qualifier', () => {
    expect(validationRange('A1:A10')).toBe('A1:A10')
    expect(validationRange('$A$1:$A$10')).toBe('$A$1:$A$10')
    expect(validationRange('Sheet2!A1:A10')).toBe('Sheet2!A1:A10')
    expect(validationRange("'My Sheet'!B2:B9")).toBe("'My Sheet'!B2:B9")
  })
  it('rejects anything Fortune-Sheet would not resolve as a range', () => {
    for (const bad of ['', 'A1:A10; DROP', 'Low, Medium', '=A1', 'Sheet2!!A1', '../etc', 'A'.repeat(90)]) {
      expect(validationRange(bad)).toBe('')
    }
  })
})

describe('validationDate — the date-operand gate', () => {
  it('accepts a real ISO calendar date', () => {
    expect(validationDate('2026-07-14')).toBe('2026-07-14')
    expect(validationDate('2024-02-29')).toBe('2024-02-29') // leap year
  })
  it('rejects impossible or free-form dates', () => {
    for (const bad of ['2023-02-29', '2026-13-01', '14/07/2026', 'today', '']) {
      expect(validationDate(bad)).toBe('')
    }
  })
})

describe('buildRegulation — dropdown from a range (incl. cross-sheet)', () => {
  it('stores the range as value1, which Fortune-Sheet reads as a live list source', () => {
    const reg = buildRegulation({ kind: 'dropdownRange', sourceRange: 'Sheet2!A1:A5', rejectInvalid: true })
    expect(reg).toMatchObject({ type: 'dropdown', type2: '', value1: 'Sheet2!A1:A5', prohibitInput: true })
    expect(validationSummary(reg)).toBe('Dropdown · from Sheet2!A1:A5')
  })
  it('multi-select sets the native type2 flag', () => {
    expect(buildRegulation({ kind: 'dropdownRange', sourceRange: 'A1:A5', allowMulti: true })!.type2).toBe('true')
  })
  it('a junk source range is REFUSED (no rule written)', () => {
    expect(buildRegulation({ kind: 'dropdownRange', sourceRange: 'not a range' })).toBeNull()
    expect(buildRegulation({ kind: 'dropdownRange', sourceRange: '' })).toBeNull()
  })
})

describe('buildRegulation — checkbox', () => {
  it('is a two-value dropdown (TRUE/FALSE by default) that always rejects other input', () => {
    const reg = buildRegulation({ kind: 'checkbox' })
    expect(reg).toMatchObject({ type: 'dropdown', value1: 'TRUE,FALSE', checkbox: true, prohibitInput: true })
    expect(validationSummary(reg)).toBe('Checkbox · TRUE / FALSE')
  })
  it('accepts custom checked/unchecked values', () => {
    const reg = buildRegulation({ kind: 'checkbox', checkedValue: 'Yes', uncheckedValue: 'No' })
    expect(reg!.value1).toBe('Yes,No')
    expect(validationSummary(reg)).toBe('Checkbox · Yes / No')
  })
  it('refuses two identical values (a checkbox with one state is not a checkbox)', () => {
    expect(buildRegulation({ kind: 'checkbox', checkedValue: 'Y', uncheckedValue: 'Y' })).toBeNull()
  })
})

describe('buildRegulation — date', () => {
  it('maps our conditions onto the native date type2 tokens', () => {
    const reg = buildRegulation({ kind: 'date', condition: 'earlierThan', value1: '2026-07-14' })
    expect(reg).toMatchObject({ type: 'date', type2: 'earlierThan', value1: '2026-07-14', value2: '' })
    expect(validationSummary(reg)).toBe('Date is before 2026-07-14')
  })
  it('between needs both dates', () => {
    expect(buildRegulation({ kind: 'date', condition: 'between', value1: '2026-01-01' })).toBeNull()
    const reg = buildRegulation({ kind: 'date', condition: 'between', value1: '2026-01-01', value2: '2026-12-31' })
    expect(reg!.value2).toBe('2026-12-31')
    expect(dateConditionArity('between')).toBe(2)
  })
  it('refuses an invalid date or an unknown condition', () => {
    expect(buildRegulation({ kind: 'date', condition: 'laterThan', value1: 'soon' })).toBeNull()
    expect(buildRegulation({ kind: 'date', condition: 'evil', value1: '2026-07-14' })).toBeNull()
  })
})

describe('buildRegulation — text content + text length', () => {
  it('text contains / does not contain / is exactly', () => {
    const reg = buildRegulation({ kind: 'text', condition: 'include', value1: 'INV-' })
    expect(reg).toMatchObject({ type: 'text_content', type2: 'include', value1: 'INV-' })
    expect(validationSummary(reg)).toBe('Text contains “INV-”')
    expect(buildRegulation({ kind: 'text', condition: 'exclude', value1: 'x' })!.type2).toBe('exclude')
    expect(buildRegulation({ kind: 'text', condition: 'equal', value1: 'x' })!.type2).toBe('equal')
  })
  it('text length takes whole numbers only', () => {
    const reg = buildRegulation({ kind: 'textLength', condition: 'lessThanOrEqualTo', value1: '10' })
    expect(reg).toMatchObject({ type: 'text_length', type2: 'lessThanOrEqualTo', value1: '10' })
    expect(validationSummary(reg)).toBe('Text length less than or equal 10')
    expect(buildRegulation({ kind: 'textLength', condition: 'between', value1: '2', value2: '8' })!.value2).toBe('8')
    expect(buildRegulation({ kind: 'textLength', condition: 'equal', value1: '3.5' })).toBeNull()
    expect(buildRegulation({ kind: 'textLength', condition: 'between', value1: '2' })).toBeNull()
  })
  it('refuses empty text and unknown conditions', () => {
    expect(buildRegulation({ kind: 'text', condition: 'include', value1: '   ' })).toBeNull()
    expect(buildRegulation({ kind: 'text', condition: 'exec', value1: 'x' })).toBeNull()
    expect(buildRegulation({ kind: 'textLength', condition: 'exec', value1: '1' })).toBeNull()
  })
  it('refuses an unknown kind outright', () => {
    expect(buildRegulation({ kind: 'formula', value1: '=1' })).toBeNull()
    expect(buildRegulation({ kind: '../../etc', value1: 'x' })).toBeNull()
    expect(buildRegulation(null)).toBeNull()
  })
})

describe('regulationToForm — round-trip back into the panel', () => {
  it('every kind the panel offers survives a build → form round-trip', () => {
    const forms = [
      { kind: 'dropdown', items: 'Low,Medium,High', allowMulti: false, rejectInvalid: true, hint: '' },
      { kind: 'dropdownRange', sourceRange: 'Sheet2!A1:A5', allowMulti: true, rejectInvalid: true, hint: '' },
      { kind: 'checkbox', checkedValue: 'Yes', uncheckedValue: 'No' },
      { kind: 'number', condition: 'between', value1: '1', value2: '10', rejectInvalid: true, hint: '' },
      { kind: 'date', condition: 'laterThan', value1: '2026-07-14', rejectInvalid: false, hint: '' },
      { kind: 'text', condition: 'include', value1: 'INV-', rejectInvalid: true, hint: 'Use the invoice prefix' },
      { kind: 'textLength', condition: 'lessThan', value1: '20', rejectInvalid: true, hint: '' },
    ]
    for (const form of forms) {
      const reg = buildRegulation(form)
      expect(reg, form.kind).toBeTruthy()
      const back = regulationToForm(reg)
      expect(back!.kind, form.kind).toBe(form.kind)
      // A rebuild from the round-tripped form is byte-identical: the panel can
      // re-open a saved rule without mutating it.
      expect(buildRegulation(back)).toEqual(reg)
    }
    // …and every advertised kind is covered above.
    expect(forms.map((f) => f.kind).sort()).toEqual(VALIDATION_KINDS.map((k) => k.value).sort())
  })
  it('keeps the hint (bounded) and the reject-invalid flag', () => {
    const reg = buildRegulation({ kind: 'number', condition: 'equal', value1: '1', rejectInvalid: false, hint: 'Enter 1' })
    expect(reg!.hintShow).toBe(true)
    expect(reg!.hintValue).toBe('Enter 1')
    expect(reg!.prohibitInput).toBe(false)
    expect(regulationToForm(reg)).toMatchObject({ hint: 'Enter 1', rejectInvalid: false })
  })
})

describe('clampRegulation — fail-closed ingress clamp', () => {
  it('passes a well-formed rule of each new kind through unchanged', () => {
    for (const form of [
      { kind: 'dropdownRange', sourceRange: 'Sheet2!A1:A5' },
      { kind: 'checkbox' },
      { kind: 'date', condition: 'between', value1: '2026-01-01', value2: '2026-12-31' },
      { kind: 'text', condition: 'include', value1: 'x' },
      { kind: 'textLength', condition: 'moreThanThe', value1: '3' },
    ]) {
      const reg = buildRegulation(form)
      expect(clampRegulation(reg)).toEqual(reg)
    }
  })
  it('DROPS a regulation with an unknown native type', () => {
    expect(clampRegulation({ type: 'validity', type2: 'identificationNumber', value1: '', value2: '' })).toBeNull()
    expect(clampRegulation({ type: 'checkbox', value1: '', value2: '' })).toBeNull() // FS's inert native checkbox
    expect(clampRegulation({ type: '__proto__', value1: 'x' })).toBeNull()
    expect(clampRegulation('nope')).toBeNull()
    expect(clampRegulation(null)).toBeNull()
  })
  it('DROPS a regulation whose condition token is not one we emit', () => {
    expect(clampRegulation({ type: 'number', type2: 'exec', value1: '1', value2: '' })).toBeNull()
    expect(clampRegulation({ type: 'date', type2: 'whenever', value1: '2026-01-01', value2: '' })).toBeNull()
    expect(clampRegulation({ type: 'text_content', type2: 'eval', value1: 'x', value2: '' })).toBeNull()
  })
  it('DROPS a regulation whose operand is junk for its type', () => {
    expect(clampRegulation({ type: 'number', type2: 'equal', value1: 'NaN-ish', value2: '' })).toBeNull()
    expect(clampRegulation({ type: 'date', type2: 'equal', value1: '2026-99-99', value2: '' })).toBeNull()
    expect(clampRegulation({ type: 'text_length', type2: 'equal', value1: '-5', value2: '' })).toBeNull()
    expect(clampRegulation({ type: 'dropdown', type2: '', value1: '', value2: '' })).toBeNull()
  })
  it('COERCES hostile strings rather than storing them raw', () => {
    const reg = clampRegulation({
      type: 'text_content', type2: 'include',
      value1: 'a\u0001b\u007fc',
      value2: '',
      hintValue: 'x'.repeat(5000),
      prohibitInput: 'yes-please', // not a boolean
    })
    expect(reg!.value1).toBe('abc')                       // control chars stripped
    expect(reg!.hintValue.length).toBeLessThanOrEqual(200) // hint is rendered — bounded
    expect(reg!.prohibitInput).toBe(true)                 // coerced to a real boolean
    expect(JSON.parse(JSON.stringify(reg))).toEqual(reg) // plain, CRDT-safe data
  })
  it('caps a monstrous dropdown list', () => {
    const reg = clampRegulation({ type: 'dropdown', type2: '', value1: Array.from({ length: 5000 }, (_, i) => `i${i}`).join(','), value2: '' })
    expect(reg!.value1.length).toBeLessThanOrEqual(2000)
  })
})

describe('clampDataValidation — the load gate', () => {
  const sheetWith = (dv: Record<string, unknown>): DVSheet[] => [{ name: 'Sheet1', celldata: [{ r: 0, c: 0, v: { v: 1, m: '1' } }], config: {}, dataVerification: dv }]

  it('keeps the good rules and drops the poisoned ones', () => {
    const good = buildRegulation({ kind: 'dropdown', items: 'a,b' })
    const data = sheetWith({
      '0_0': good,
      '0_1': { type: 'validity', type2: 'phoneNumber', value1: '', value2: '' },  // never ours
      '0_2': { type: 'number', type2: 'DROP TABLE', value1: '1', value2: '' },    // junk condition
      '0_3': null,
      'evil_key': good,                                                            // malformed key
      '__proto__': good,
    })
    const clamped = clampDataValidation(data)
    const dv = clamped[0].dataVerification!
    expect(Object.keys(dv)).toEqual(['0_0'])
    expect(dv['0_0']).toEqual(good)
    // The input is untouched (immutable, like every other clamp).
    expect(Object.keys(data[0].dataVerification!)).toContain('0_1')
  })
  it('leaves a sheet with no validation alone', () => {
    const data = [{ name: 'Sheet1', celldata: [], config: {} }]
    expect(clampDataValidation(data)).toEqual(data)
    expect(clampDataValidation(undefined)).toEqual([])
  })
  it('a clamped workbook still lists its rules', () => {
    const reg = buildRegulation({ kind: 'date', condition: 'earlierThan', value1: '2026-07-14' })
    const data = applyValidation([{ name: 'Sheet1', celldata: [], config: {} }], 'A1:A3', reg, parseRangeTyped)
    const rules = listValidationRules(clampDataValidation(data)[0])
    expect(rules).toHaveLength(1)
    expect(rules[0].count).toBe(3)
    expect(rules[0].summary).toBe('Date is before 2026-07-14')
  })
  it('a checkbox and a plain dropdown over the same values stay distinct rules', () => {
    let data = applyValidation([{ name: 'Sheet1', celldata: [], config: {} }], 'A1', buildRegulation({ kind: 'checkbox' }), parseRangeTyped)
    data = applyValidation(data, 'B1', buildRegulation({ kind: 'dropdown', items: 'TRUE,FALSE' }), parseRangeTyped)
    const rules = listValidationRules(clampDataValidation(data)[0])
    expect(rules).toHaveLength(2)
    expect(rules.map((r) => r.summary).sort()).toEqual(['Checkbox · TRUE / FALSE', 'Dropdown · 2 items'])
  })
})

describe('condition tables', () => {
  it('expose the native tokens Fortune-Sheet actually understands', () => {
    expect(DATE_CONDITIONS.map((c) => c.value)).toEqual([
      'between', 'notBetween', 'equal', 'notEqualTo',
      'earlierThan', 'noEarlierThan', 'laterThan', 'noLaterThan',
    ])
    expect(TEXT_CONDITIONS.map((c) => c.value)).toEqual(['include', 'exclude', 'equal'])
  })
})
