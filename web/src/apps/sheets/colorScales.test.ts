/**
 * colorScales.test.js  (WAVE-63)
 * CF color scales + data bars: ingress clamp (hex/kind validation), correct
 * gradient/bar computation, reactivity signature, and CRDT-safety.
 * The WAVE-64 single-colour rules (value/text/date/empty/duplicate/formula) are
 * covered in colorScaleRules.test.js.
 */
import { describe, it, expect } from 'vitest'
import {
  makeColorScale, getColorScales, insertColorScale, updateColorScale, deleteColorScale,
  clampColorScales, computeColorScale, computeAllColorScales, colorScaleSignature,
  safeColor, parseBounds, CS_KINDS, toNativeConditionFormat, buildNativeConditionFormat,
  type CSSheet, type CSCellEntry, type ColorScaleRule, type PaintBg, type PaintBar,
  type NativeConditionFormat,
} from './colorScales.js'

// A couple of fixtures below deliberately never pass through makeColorScale
// (the render-boundary re-clamp under test), so they don't structurally match
// ColorScaleRule; cast through unknown at those call sites, same as
// colorScaleRules.test.ts.
function cast<T>(v: unknown): T { return v as T }

function sheetFrom(cells: Record<string, number>): CSSheet & { celldata: CSCellEntry[] } {
  // cells: { "r_c": number }
  const celldata: CSCellEntry[] = Object.entries(cells).map(([k, v]) => {
    const [r, c] = k.split('_').map(Number)
    return { r, c, v: { v, m: String(v), ct: { fa: 'General', t: 'n' } } }
  })
  return { name: 'Sheet1', celldata, config: {} }
}

describe('safeColor — colour validation (injection guard)', () => {
  it('accepts valid hex, lower-cases', () => {
    expect(safeColor('#FF0000')).toBe('#ff0000')
    expect(safeColor('#abc')).toBe('#abc')
  })
  it('rejects anything non-hex → fallback', () => {
    expect(safeColor('url(javascript:alert(1))', '#000000')).toBe('#000000')
    expect(safeColor('red', '#111111')).toBe('#111111')
    expect(safeColor('expression(x)', '#222222')).toBe('#222222')
    expect(safeColor(123, '#333333')).toBe('#333333')
  })
})

describe('makeColorScale — ingress clamp', () => {
  it('allow-lists kind, validates every colour, normalises range', () => {
    const r = makeColorScale({ kind: 'evil', range: 'a1:a9', min: 'BAD', max: '#00FF00', barColor: 'url(x)' })
    expect(r.kind).toBe('colorScale2')          // unknown → default
    expect(r.range).toBe('A1:A9')
    expect(r.min).toMatch(/^#/)                  // invalid colour → safe default
    expect(r.max).toBe('#00ff00')
    expect(r.barColor).toMatch(/^#/)             // 'url(x)' rejected → default
    expect(JSON.parse(JSON.stringify(r))).toEqual(r) // CRDT-safe
  })
  it('keeps a valid id + every valid kind', () => {
    expect(makeColorScale({ id: 'cs_x' }).id).toBe('cs_x')
    for (const k of CS_KINDS) expect(makeColorScale({ kind: k }).kind).toBe(k)
  })
})

describe('immutable ops', () => {
  it('insert / update / delete', () => {
    const data = [sheetFrom({ '0_0': 1 })]
    const a = insertColorScale(data, { kind: 'dataBar', range: 'A1:A3' })
    expect(getColorScales(a)).toHaveLength(1)
    const id = getColorScales(a)[0].id
    const b = updateColorScale(a, id, { kind: 'colorScale3' })
    expect(getColorScales(b)[0].kind).toBe('colorScale3')
    expect(getColorScales(a)[0].kind).toBe('dataBar')  // input not mutated
    expect(getColorScales(deleteColorScale(b, id))).toHaveLength(0)
  })
})

describe('computeColorScale — 2-colour scale', () => {
  it('min→max gradient endpoints are the configured colours', () => {
    const sheet = sheetFrom({ '0_0': 0, '1_0': 5, '2_0': 10 })
    const rule = makeColorScale({ kind: 'colorScale2', range: 'A1:A3', min: '#000000', max: '#ffffff' })
    const m = computeColorScale(rule, sheet)
    expect(cast<PaintBg>(m['0_0']).bg).toBe('rgb(0, 0, 0)')       // min value → min colour
    expect(cast<PaintBg>(m['2_0']).bg).toBe('rgb(255, 255, 255)') // max value → max colour
    expect(cast<PaintBg>(m['1_0']).bg).toBe('rgb(128, 128, 128)') // midpoint → interpolated
  })
})

describe('computeColorScale — 3-colour scale', () => {
  it('interpolates min→mid→max around the midpoint', () => {
    const sheet = sheetFrom({ '0_0': 0, '1_0': 5, '2_0': 10 })
    const rule = makeColorScale({ kind: 'colorScale3', range: 'A1:A3', min: '#000000', mid: '#808080', max: '#ffffff' })
    const m = computeColorScale(rule, sheet)
    expect(cast<PaintBg>(m['0_0']).bg).toBe('rgb(0, 0, 0)')
    expect(cast<PaintBg>(m['1_0']).bg).toBe('rgb(128, 128, 128)') // exactly the mid colour at the midpoint
    expect(cast<PaintBg>(m['2_0']).bg).toBe('rgb(255, 255, 255)')
  })
})

describe('computeColorScale — data bar', () => {
  it('bar pct proportional to |value| against the largest magnitude', () => {
    const sheet = sheetFrom({ '0_0': 0, '1_0': 50, '2_0': 100 })
    const rule = makeColorScale({ kind: 'dataBar', range: 'A1:A3', barColor: '#638ec6' })
    const m = computeColorScale(rule, sheet)
    expect(cast<PaintBar>(m['0_0']).bar.pct).toBe(0)
    expect(cast<PaintBar>(m['1_0']).bar.pct).toBe(0.5)
    expect(cast<PaintBar>(m['2_0']).bar.pct).toBe(1)
    expect(cast<PaintBar>(m['2_0']).bar.color).toBe('#638ec6')
    expect(cast<PaintBar>(m['1_0']).bar.negative).toBe(false)
  })
  it('negative values flagged for left-painting', () => {
    const sheet = sheetFrom({ '0_0': -10, '1_0': 10 })
    const m = computeColorScale(makeColorScale({ kind: 'dataBar', range: 'A1:A2' }), sheet)
    expect(cast<PaintBar>(m['0_0']).bar.negative).toBe(true)
    expect(cast<PaintBar>(m['0_0']).bar.pct).toBe(1)
    expect(cast<PaintBar>(m['1_0']).bar.negative).toBe(false)
  })
})

describe('percent + boundary correctness', () => {
  it('reads a "50%" string as 0.5, not 50 (no 100x distortion)', () => {
    // Mix a percent string with plain fractions; scale must not be dominated.
    const sheet = {
      name: 'S', config: {},
      celldata: [
        { r: 0, c: 0, v: { v: '50%', m: '50%', ct: { t: 's' } } },
        { r: 1, c: 0, v: { v: 0.8, m: '0.8', ct: { t: 'n' } } },
        { r: 2, c: 0, v: { v: 1, m: '1', ct: { t: 'n' } } },
      ],
    }
    const m = computeColorScale(makeColorScale({ kind: 'dataBar', range: 'A1:A3' }), sheet)
    // 0.5 / 0.8 / 1.0 against scale 1.0 → 0.5 / 0.8 / 1.0 (percent read correctly)
    expect(cast<PaintBar>(m['0_0']).bar.pct).toBeCloseTo(0.5, 5)
    expect(cast<PaintBar>(m['2_0']).bar.pct).toBe(1)
  })

  it('native bands do not overlap on a boundary value (half-open)', () => {
    const sheet = sheetFrom({ '0_0': 0, '1_0': 6, '2_0': 12 }) // 12-wide domain, 12 bands
    const native = toNativeConditionFormat(makeColorScale({ kind: 'colorScale2', range: 'A1:A3' }), sheet, undefined)
    // Count how many bands contain exactly the boundary value 6.
    const hit = native.filter((r) => 6 >= Number(r.conditionValue[0]) && 6 <= Number(r.conditionValue[1]))
    expect(hit.length).toBe(1) // exactly one band claims the boundary value
  })
})

describe('edge cases', () => {
  it('empty / non-numeric range → empty map', () => {
    expect(computeColorScale(makeColorScale({ range: 'A1:A3' }), sheetFrom({}))).toEqual({})
    expect(computeColorScale(makeColorScale({ range: 'garbage' }), sheetFrom({ '0_0': 1 }))).toEqual({})
  })
  it('all-equal values do not divide by zero', () => {
    const sheet = sheetFrom({ '0_0': 7, '1_0': 7 })
    const m = computeColorScale(makeColorScale({ kind: 'colorScale2', range: 'A1:A2', min: '#000000', max: '#ffffff' }), sheet)
    expect(cast<PaintBg>(m['0_0']).bg).toBe('#000000') // min colour when max===min (no NaN)
  })
})

describe('reactivity signature', () => {
  it('changes when a source value changes, stable otherwise', () => {
    const rule = makeColorScale({ kind: 'dataBar', range: 'A1:A3' })
    const s1 = sheetFrom({ '0_0': 1, '1_0': 2, '2_0': 3 })
    const sigA = colorScaleSignature(rule, s1)
    const s2 = sheetFrom({ '0_0': 1, '1_0': 99, '2_0': 3 })
    expect(colorScaleSignature(rule, s2)).not.toBe(sigA)
    // unrelated cell outside range → stable
    const s3 = { ...s1, celldata: [...s1.celldata, { r: 50, c: 50, v: { v: 1, m: '1', ct: { t: 'n' } } }] }
    expect(colorScaleSignature(rule, s3)).toBe(sigA)
  })
})

describe('computeAllColorScales', () => {
  it('merges multiple rules, later rules win on overlap', () => {
    const sheet = sheetFrom({ '0_0': 10 })
    const rules = [
      makeColorScale({ kind: 'colorScale2', range: 'A1', min: '#000000', max: '#000000' }),
      makeColorScale({ kind: 'dataBar', range: 'A1' }),
    ]
    const m = computeAllColorScales(rules, sheet)
    expect(cast<PaintBar>(m['0_0']).bar).toBeTruthy() // dataBar (later) wins
  })
})

describe('clampColorScales — defensive load clamp', () => {
  it('re-clamps corrupt local rules', () => {
    // Corrupt local record, never went through makeColorScale — the exact gap
    // clampColorScales re-clamps.
    const data = [{ ...sheetFrom({ '0_0': 1 }), colorScales: cast<ColorScaleRule[]>([{ id: 'x', kind: 'HACK', min: 'evil', range: 'a1' }]) }]
    const clamped = clampColorScales(data)
    expect(getColorScales(clamped)[0].kind).toBe('colorScale2')
    expect(getColorScales(clamped)[0].min).toMatch(/^#/)
  })
})

describe('parseBounds', () => {
  it('parses ranges + single cells', () => {
    expect(parseBounds('A1:B3')).toEqual({ r0: 0, r1: 2, c0: 0, c1: 1 })
    expect(parseBounds('C2')).toEqual({ r0: 1, r1: 1, c0: 2, c1: 2 })
    expect(parseBounds('nope')).toBeNull()
  })
})

describe('toNativeConditionFormat — canvas rendering via FS-native band rules', () => {
  it('emits between rules spanning the value domain with valid hex colours', () => {
    const sheet = sheetFrom({ '0_0': 0, '1_0': 50, '2_0': 100 })
    const rule = makeColorScale({ kind: 'colorScale2', range: 'A1:A3', min: '#000000', max: '#ffffff' })
    const native = toNativeConditionFormat(rule, sheet, undefined)
    expect(native.length).toBeGreaterThan(1)
    for (const n of native) {
      expect(n.conditionName).toBe('between')
      // conditionValue is numeric (no cell-derived / hostile value)
      expect(typeof n.conditionValue[0]).toBe('number')
      expect(typeof n.conditionValue[1]).toBe('number')
      // cellColor is a strict #rrggbb from our palette (injection-safe)
      expect(n.format.cellColor).toMatch(/^#[0-9a-f]{6}$/)
    }
    // First band starts at the min, last band ends at the max.
    expect(native[0].conditionValue[0]).toBe(0)
    expect(native[native.length - 1].conditionValue[1]).toBe(100)
  })

  it('data bars become an intensity ramp of the bar colour', () => {
    const sheet = sheetFrom({ '0_0': 1, '1_0': 10 })
    const native = toNativeConditionFormat(makeColorScale({ kind: 'dataBar', range: 'A1:A2', barColor: '#638ec6' }), sheet, undefined)
    expect(native.length).toBeGreaterThan(1)
    expect(native.every((n) => /^#[0-9a-f]{6}$/.test(n.format.cellColor))).toBe(true)
  })

  it('returns [] for a range with no numeric values', () => {
    expect(toNativeConditionFormat(makeColorScale({ range: 'A1:A3' }), sheetFrom({}), undefined)).toEqual([])
  })
})

describe('buildNativeConditionFormat — merges user rules + derived bands', () => {
  it('marks derived bands and preserves user rules', () => {
    const sheet = {
      ...sheetFrom({ '0_0': 1, '1_0': 2, '2_0': 3 }),
      colorScales: [makeColorScale({ kind: 'colorScale2', range: 'A1:A3' })],
      // A simplified user rule -- buildNativeConditionFormat only reads
      // __fromColorScale off it here, not the full native shape.
      luckysheet_conditionformat_save: cast<NativeConditionFormat[]>([{ conditionName: 'greaterThan', conditionValue: [5], format: { cellColor: '#ff0000' } }]),
    }
    const merged = buildNativeConditionFormat(sheet, undefined)
    const derived = merged.filter((r) => r.__fromColorScale)
    const user = merged.filter((r) => !r.__fromColorScale)
    expect(derived.length).toBeGreaterThan(0)
    expect(user).toHaveLength(1)
    expect(user[0].conditionName).toBe('greaterThan')
  })

  it('does not re-derive from a previously-injected __fromColorScale rule (idempotent)', () => {
    const sheet = {
      ...sheetFrom({ '0_0': 1, '1_0': 2 }),
      colorScales: [makeColorScale({ kind: 'dataBar', range: 'A1:A2' })],
      // A stale injected rule must be dropped, not treated as a user rule.
      luckysheet_conditionformat_save: cast<NativeConditionFormat[]>([{ __fromColorScale: true, conditionName: 'between', conditionValue: [0, 1], format: { cellColor: '#111111' } }]),
    }
    const merged = buildNativeConditionFormat(sheet, undefined)
    expect(merged.filter((r) => !r.__fromColorScale)).toHaveLength(0)
  })
})
