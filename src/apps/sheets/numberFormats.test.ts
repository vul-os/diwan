/**
 * numberFormats.test.js — unit tests for cell number-format presets.
 */
import { describe, it, expect } from 'vitest'
import {
  presetById,
  ctForPreset,
  normalizeCellObject,
  applyNumberFormat,
  detectPresetId,
  type CellEntry,
  type CellObject,
} from './numberFormats.js'

// Test fixtures know their own cell shapes; this narrows `CellEntry.v`'s
// CellValue union (string|number|boolean|null|undefined|CellObject) back to
// the object form so assertions can reach `.ct`/`.v` directly.
const asObj = (cell: CellEntry | undefined): CellObject => cell!.v as CellObject

describe('presetById / ctForPreset', () => {
  it('resolves known preset', () => {
    expect(presetById('currency')!.label).toBe('Currency ($)')
  })
  it('unknown → null', () => {
    expect(presetById('nope')).toBeNull()
  })
  it('ctForPreset returns fa/t for real presets', () => {
    expect(ctForPreset('percent')).toEqual({ fa: '0.00%', t: 'n' })
  })
  it('ctForPreset("general") → null (means: clear format)', () => {
    expect(ctForPreset('general')).toBeNull()
  })
})

describe('normalizeCellObject', () => {
  it('wraps a scalar', () => {
    expect(normalizeCellObject(5)).toEqual({ v: 5, m: '5' })
  })
  it('clones an object form', () => {
    const src = { v: 1, m: '1', ct: { fa: 'General', t: 'n' } }
    const out = normalizeCellObject(src)
    expect(out).toEqual(src)
    expect(out).not.toBe(src)
  })
  it('null/undefined → empty', () => {
    expect(normalizeCellObject(null)).toEqual({ v: '', m: '' })
    expect(normalizeCellObject(undefined)).toEqual({ v: '', m: '' })
  })
})

describe('applyNumberFormat', () => {
  const data = [{
    name: 'Sheet1',
    celldata: [
      { r: 0, c: 0, v: { v: 12.5, m: '12.5', ct: { fa: 'General', t: 'n' } } },
      { r: 0, c: 1, v: 99 },                       // bare scalar
      { r: 5, c: 5, v: { v: 1, m: '1' } },         // out of range
    ],
    config: {},
  }]

  it('stamps ct.fa on in-range cells only', () => {
    const next = applyNumberFormat(data, [0, 0], [0, 1], 'currency')
    const cells = next[0].celldata!
    expect(asObj(cells.find((c) => c.r === 0 && c.c === 0)).ct).toEqual({ fa: '"$"#,##0.00', t: 'n' })
    expect(asObj(cells.find((c) => c.r === 0 && c.c === 1)).ct).toEqual({ fa: '"$"#,##0.00', t: 'n' })
    // out-of-range untouched
    expect(asObj(cells.find((c) => c.r === 5 && c.c === 5)).ct).toBeUndefined()
  })

  it('never mutates the raw value v', () => {
    const next = applyNumberFormat(data, [0, 0], [0, 0], 'percent')
    expect(asObj(next[0].celldata!.find((c) => c.r === 0 && c.c === 0)).v).toBe(12.5)
  })

  it('is immutable', () => {
    applyNumberFormat(data, [0, 0], [0, 1], 'currency')
    expect(asObj(data[0].celldata![0]).ct!.fa).toBe('General')
  })

  it('general clears back to automatic', () => {
    const withFmt = applyNumberFormat(data, [0, 0], [0, 0], 'currency')
    const cleared = applyNumberFormat(withFmt, [0, 0], [0, 0], 'general')
    expect(asObj(cleared[0].celldata!.find((c) => c.r === 0 && c.c === 0)).ct).toEqual({ fa: 'General', t: 'g' })
  })
})

describe('detectPresetId', () => {
  it('matches a known format code', () => {
    expect(detectPresetId({ ct: { fa: '0.00%', t: 'n' } })).toBe('percent')
  })
  it('General / unknown / scalar → general', () => {
    expect(detectPresetId({ ct: { fa: 'General' } })).toBe('general')
    expect(detectPresetId({ ct: { fa: 'weird' } })).toBe('general')
    expect(detectPresetId(42)).toBe('general')
    expect(detectPresetId(null)).toBe('general')
  })
})
