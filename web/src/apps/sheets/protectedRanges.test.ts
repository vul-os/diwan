import { describe, it, expect } from 'vitest'
import {
  makeProtectedRange, clampRect, getProtectedRanges, setProtectedRanges,
  insertProtectedRange, deleteProtectedRange, updateProtectedRange,
  clampProtectedRanges, mergeProtectedRanges, cellProtection, rectToA1,
  type PRSheet,
} from './protectedRanges.js'

const sheet = (extra: Partial<PRSheet> = {}): PRSheet[] => [{ name: 'Sheet1', id: 'sheet_1', celldata: [], ...extra }]

describe('protectedRanges model', () => {
  it('clampRect normalises order and rejects negatives', () => {
    expect(clampRect({ startRow: 5, startCol: 5, endRow: 1, endCol: 2 }))
      .toEqual({ startRow: 1, startCol: 2, endRow: 5, endCol: 5 })
    expect(clampRect({ startRow: -3, startCol: -1, endRow: 2, endCol: 2 }))
      .toEqual({ startRow: 0, startCol: 0, endRow: 2, endCol: 2 })
  })

  it('makeProtectedRange clamps fields and mints an id', () => {
    const pr = makeProtectedRange({ range: { startRow: 1, startCol: 1, endRow: 1, endCol: 1 }, warningOnly: 'yes', editors: ['a', 'a', '', 'b', 5] })
    expect(pr.id).toMatch(/^pr_/)
    expect(pr.warningOnly).toBe(true)
    // de-duped, drops empty + non-strings
    expect(pr.editors).toEqual(['a', 'b'])
    expect(pr.sheetIndex).toBe(0)
  })

  it('insert / delete / update round-trip on sheet[0]', () => {
    let data = sheet()
    data = insertProtectedRange(data, { id: 'pr1', range: { startRow: 1, startCol: 1, endRow: 1, endCol: 1 }, editors: ['bob'] })
    expect(getProtectedRanges(data)).toHaveLength(1)
    data = updateProtectedRange(data, 'pr1', { warningOnly: true })
    expect(getProtectedRanges(data)[0].warningOnly).toBe(true)
    data = deleteProtectedRange(data, 'pr1')
    expect(getProtectedRanges(data)).toHaveLength(0)
    // empty list drops the field entirely
    expect(data[0].protectedRanges).toBeUndefined()
  })

  it('clampProtectedRanges re-clamps a poisoned persisted record', () => {
    // Deliberately malformed (wrong types on warningOnly/editors) to exercise the
    // fail-closed clamp on a poisoned/legacy record — hence the `unknown` cast.
    const poisoned = sheet({ protectedRanges: [{ id: 'x', sheetIndex: -9, range: { startRow: -1, startCol: 2, endRow: 3, endCol: 0 }, warningOnly: 1, editors: 'not-an-array' }] as unknown as PRSheet['protectedRanges'] })
    const out = clampProtectedRanges(poisoned)
    const pr = getProtectedRanges(out)[0]
    expect(pr.sheetIndex).toBe(0)
    expect(pr.range).toEqual({ startRow: 0, startCol: 0, endRow: 3, endCol: 2 })
    expect(pr.editors).toEqual([])
  })

  it('mergeProtectedRanges re-attaches ranges FortuneSheet onChange dropped', () => {
    const withRanges = insertProtectedRange(sheet(), { id: 'pr1', range: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 } })
    const saved = getProtectedRanges(withRanges)
    // FortuneSheet re-emits sheets WITHOUT the app-owned field:
    const normalised = sheet()
    expect(getProtectedRanges(normalised)).toHaveLength(0)
    const merged = mergeProtectedRanges(normalised, saved)
    expect(getProtectedRanges(merged)).toHaveLength(1)
    // incoming ranges win (authoritative panel edit) — no double-attach
    const already = insertProtectedRange(sheet(), { id: 'pr2', range: { startRow: 1, startCol: 1, endRow: 1, endCol: 1 } })
    expect(getProtectedRanges(mergeProtectedRanges(already, saved))[0].id).toBe('pr2')
  })

  it('cellProtection reports restricted + canEdit correctly', () => {
    const data = insertProtectedRange(sheet(), {
      id: 'pr1', sheetIndex: 0, range: { startRow: 1, startCol: 1, endRow: 2, endCol: 2 },
      warningOnly: false, editors: ['carol'],
    })
    // B2 (r1,c1) is inside; bob cannot edit, carol can, owner can.
    expect(cellProtection(data, 0, 1, 1, 'bob', 'alice')).toMatchObject({ restricted: true, canEdit: false })
    expect(cellProtection(data, 0, 1, 1, 'carol', 'alice')).toMatchObject({ restricted: true, canEdit: true })
    expect(cellProtection(data, 0, 1, 1, 'alice', 'alice')).toMatchObject({ restricted: true, canEdit: true })
    // A1 (r0,c0) is outside the rect → no protection.
    expect(cellProtection(data, 0, 0, 0, 'bob', 'alice')).toBeNull()
    // different sheet index → no protection.
    expect(cellProtection(data, 1, 1, 1, 'bob', 'alice')).toBeNull()
  })

  it('rectToA1 renders single cell and range labels', () => {
    expect(rectToA1({ startRow: 0, startCol: 0, endRow: 0, endCol: 0 })).toBe('A1')
    expect(rectToA1({ startRow: 1, startCol: 1, endRow: 9, endCol: 3 })).toBe('B2:D10')
  })

  it('setProtectedRanges caps the list length', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ id: `pr${i}`, range: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 } }))
    const out = setProtectedRanges(sheet(), many)
    expect(getProtectedRanges(out).length).toBeLessThanOrEqual(200)
  })
})
