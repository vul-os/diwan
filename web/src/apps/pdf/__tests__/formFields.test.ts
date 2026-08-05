import { describe, it, expect } from 'vitest'
import {
  fieldKind, toField, extractFields, pdfRectToScreen, screenPointToPdf,
  fieldsToAnnotations,
  FIELD_TEXT, FIELD_CHECKBOX, FIELD_RADIO, FIELD_CHOICE, FIELD_SIGNATURE,
  type FormField,
} from '../formFields'

describe('formFields — fieldKind', () => {
  it('maps the AcroForm field types', () => {
    expect(fieldKind({ subtype: 'Widget', fieldType: 'Tx' })).toBe(FIELD_TEXT)
    expect(fieldKind({ subtype: 'Widget', fieldType: 'Ch' })).toBe(FIELD_CHOICE)
    expect(fieldKind({ subtype: 'Widget', fieldType: 'Sig' })).toBe(FIELD_SIGNATURE)
    expect(fieldKind({ subtype: 'Widget', fieldType: 'Btn', radioButton: true })).toBe(FIELD_RADIO)
    expect(fieldKind({ subtype: 'Widget', fieldType: 'Btn', checkBox: true })).toBe(FIELD_CHECKBOX)
  })
  it('returns null for non-widget and push-button annotations', () => {
    expect(fieldKind({ subtype: 'Link' })).toBeNull()
    expect(fieldKind({ subtype: 'Widget', fieldType: 'Btn', pushButton: true })).toBeNull()
    expect(fieldKind(null)).toBeNull()
  })
})

describe('formFields — toField', () => {
  it('normalises a text field', () => {
    const f = toField({ subtype: 'Widget', fieldType: 'Tx', fieldName: 'email', fieldValue: 'a@b.c', rect: [10, 20, 110, 40] })
    expect(f).toMatchObject({ name: 'email', kind: FIELD_TEXT, value: 'a@b.c', readOnly: false })
    expect(f!.rect).toEqual([10, 20, 110, 40])
  })
  it('captures choice options and checkbox on/checked state', () => {
    const choice = toField({ subtype: 'Widget', fieldType: 'Ch', fieldName: 'country', rect: [0, 0, 1, 1], options: [{ displayValue: 'US' }, { displayValue: 'CA' }] })
    expect(choice!.options).toEqual(['US', 'CA'])

    const cb = toField({ subtype: 'Widget', fieldType: 'Btn', checkBox: true, fieldName: 'agree', exportValue: 'Yes', fieldValue: 'Yes', rect: [0, 0, 10, 10] })
    expect(cb!.kind).toBe(FIELD_CHECKBOX)
    expect(cb!.onValue).toBe('Yes')
    expect(cb!.checked).toBe(true)

    const cbOff = toField({ subtype: 'Widget', fieldType: 'Btn', checkBox: true, fieldName: 'agree', fieldValue: 'Off', rect: [0, 0, 10, 10] })
    expect(cbOff!.checked).toBe(false)
  })
  it('drops widgets with no rect', () => {
    expect(toField({ subtype: 'Widget', fieldType: 'Tx', fieldName: 'x' })).toBeNull()
  })
})

describe('formFields — extractFields', () => {
  it('keeps only fillable widgets', () => {
    const anns = [
      { subtype: 'Link' },
      { subtype: 'Widget', fieldType: 'Btn', pushButton: true, rect: [0, 0, 1, 1] },
      { subtype: 'Widget', fieldType: 'Tx', fieldName: 'name', rect: [0, 0, 1, 1] },
      { subtype: 'Widget', fieldType: 'Btn', checkBox: true, fieldName: 'ok', rect: [0, 0, 1, 1] },
    ]
    const fields = extractFields(anns)
    expect(fields.map((f) => f.kind)).toEqual([FIELD_TEXT, FIELD_CHECKBOX])
  })
  it('handles non-array input', () => {
    expect(extractFields(null)).toEqual([])
    expect(extractFields(undefined)).toEqual([])
  })
})

describe('formFields — coordinate mapping (the risky geometry)', () => {
  it('flips Y and scales PDF rect to screen', () => {
    // Page 800 units tall, scale 2. Field at PDF [100, 700, 300, 750] (near top).
    const box = pdfRectToScreen([100, 700, 300, 750], 800, 2)
    expect(box.left).toBe(200)      // 100 * 2
    expect(box.width).toBe(400)     // (300-100) * 2
    expect(box.height).toBe(100)    // (750-700) * 2
    // top = (800 - 750) * 2 = 100  (field near the top of the page → small top)
    expect(box.top).toBe(100)
  })
  it('a field near the page bottom maps to a large top offset', () => {
    const box = pdfRectToScreen([0, 0, 10, 20], 800, 1)
    expect(box.top).toBe(780)       // (800 - 20)
  })
  it('screenPointToPdf inverts the mapping', () => {
    const h = 800, s = 2
    const box = pdfRectToScreen([100, 700, 300, 750], h, s)
    // The screen top-left of the box maps back to the field's PDF top-left.
    const back = screenPointToPdf(box.left, box.top, h, s)
    expect(back.x).toBeCloseTo(100, 6)
    expect(back.y).toBeCloseTo(750, 6) // PDF top edge (larger Y)
  })
  it('is robust to a rect given in either corner order', () => {
    const a = pdfRectToScreen([300, 750, 100, 700], 800, 2) // reversed corners
    const b = pdfRectToScreen([100, 700, 300, 750], 800, 2)
    expect(a).toEqual(b)
  })
})

describe('formFields — fieldsToAnnotations', () => {
  let n = 0
  const genId = () => `id${n++}`
  it('seeds text + checkbox annotations, skips read-only', () => {
    n = 0
    const fields: FormField[] = [
      { id: 'f1', name: 'name', kind: FIELD_TEXT, value: 'Ada', rect: [10, 700, 210, 730], readOnly: false },
      { id: 'f2', name: 'sig', kind: FIELD_SIGNATURE, value: '', rect: [10, 600, 210, 640], readOnly: false },
      { id: 'f3', name: 'agree', kind: FIELD_CHECKBOX, value: '', checked: true, rect: [10, 500, 30, 520], readOnly: false },
      { id: 'f4', name: 'locked', kind: FIELD_TEXT, value: 'x', rect: [10, 400, 210, 430], readOnly: true },
    ]
    const seeds = fieldsToAnnotations(fields, 1, 800, 1, '#111', genId)
    // signature field is not seeded as text; read-only is skipped.
    expect(seeds.length).toBe(2)
    const text = seeds.find((s) => s.fieldName === 'name')
    expect(text!.type).toBe('text')
    expect(text!.content).toBe('Ada')
    expect(text!.fromForm).toBe(true)
    expect(text!.pageIndex).toBe(1)
    const cb = seeds.find((s) => s.fieldName === 'agree')
    expect(cb!.checkbox).toBe(true)
    expect(cb!.content).toBe('✓') // checked
  })
})
