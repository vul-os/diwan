/**
 * charts.test.js (WAVE-54)
 * Pure-model tests: insert from range, reactivity to a cell change, untrusted
 * label escaping (no injection), and immutable delete.
 */
import { describe, it, expect } from 'vitest'
import {
  makeChart, insertChart, updateChart, deleteChart, getCharts,
  extractChartData, chartValuesSignature, escapeChartText, chartAccessibleSummary,
  chartsBySheetId, mergeCharts, clampCharts,
  CHART_TYPES, CHART_TYPE_GROUPS, stackModeOf, isHorizontalBar, histogramBins, histogramValues,
  type ChartSheet, type ChartCellValue,
} from './charts.js'

// Test fixtures know their own cell shapes; narrows ChartCellEntry['v']'s union
// (string|number|boolean|ChartCellValue|null|undefined) back to the object form
// so assertions can reach `.v`/`.m` directly, matching numberFormats.test.ts's asObj.
const asCellValue = (v: ChartCellValue | string | number | boolean | null | undefined): ChartCellValue => v as ChartCellValue

// Build a FortuneSheet-style workbook with the given cell display values.
// cells: { "r_c": value }
function wb(cells: Record<string, string | number> = {}): ChartSheet[] {
  const celldata = Object.entries(cells).map(([k, v]) => {
    const [r, c] = k.split('_').map(Number)
    return { r, c, v: { v, m: String(v), ct: { fa: 'General', t: typeof v === 'number' ? 'n' : 'g' } } }
  })
  return [{ name: 'Sheet1', celldata, config: {} }]
}

describe('chart model', () => {
  it('makeChart clamps type and geometry, always returns plain data', () => {
    const c = makeChart({ type: 'evil', x: -999, w: 1e9, title: 'x' })
    expect(c.type).toBe('column')          // unknown → default
    expect(c.x).toBe(0)                     // clamped to lower bound
    expect(c.w).toBe(4000)                  // clamped to upper bound
    expect(typeof c.id).toBe('string')
    expect(JSON.parse(JSON.stringify(c))).toEqual(c) // serialisable = CRDT-safe
  })

  // WAVE-55: makeChart is the CRDT-ingress sanitiser (SheetsEditor runs every
  // peer-supplied descriptor through it before merge). Pin the fail-closed
  // coercion of the fields a hostile peer could weaponise: a non-string title
  // (→ React-child crash), non-finite geometry (→ NaN layout / render escape),
  // and non-string axis labels. All must become safe plain data.
  it('makeChart sanitises a hostile peer descriptor fail-closed (CRDT ingress)', () => {
    const c = makeChart({
      id: 'evil', type: '__proto__',
      title: { toString: () => 'boom' },        // object title → ''
      options: { xAxisLabel: {}, yAxisLabel: [], legend: 'yes' },
      x: NaN, y: Infinity, w: -1e9, h: 'nope',
    })
    expect(c.type).toBe('column')               // unknown type → default
    expect(c.title).toBe('')                    // non-string title coerced away
    expect(c.options.xAxisLabel).toBe('')       // non-string label coerced away
    expect(c.options.yAxisLabel).toBe('')
    expect(Number.isFinite(c.x) && Number.isFinite(c.y)).toBe(true)
    expect(Number.isFinite(c.w) && Number.isFinite(c.h)).toBe(true)
    expect(c.w).toBeGreaterThanOrEqual(160)     // clamped to sane bounds
    expect(c.h).toBeGreaterThanOrEqual(120)
    expect(c.id).toBe('evil')                   // valid string id preserved (LWW key)
    expect(JSON.parse(JSON.stringify(c))).toEqual(c)  // pure serialisable data
  })

  it('inserts a chart from a selected range onto sheet.charts', () => {
    const data = wb({ '0_0': 'Q', '0_1': 'Sales', '1_0': 'A', '1_1': 10, '2_0': 'B', '2_1': 20 })
    const next = insertChart(data, { type: 'column', range: 'A1:B3', title: 'My chart' })
    const charts = getCharts(next)
    expect(charts).toHaveLength(1)
    expect(charts[0].range).toBe('A1:B3')
    expect(charts[0].title).toBe('My chart')
    // immutable
    expect(getCharts(data)).toHaveLength(0)
  })
})

describe('extractChartData', () => {
  it('extracts categories + numeric series with headers', () => {
    const data = wb({
      '0_0': 'Region', '0_1': 'Sales',
      '1_0': 'North', '1_1': 10,
      '2_0': 'South', '2_1': 25,
    })
    const chart = makeChart({ range: 'A1:B3', options: { headerRow: true, headerCol: true } })
    const out = extractChartData(chart, data[0])
    expect(out.categories).toEqual(['North', 'South'])
    expect(out.series).toHaveLength(1)
    expect(out.series[0].name).toBe('Sales')
    expect(out.series[0].values).toEqual([10, 25])
    expect(out.empty).toBe(false)
  })

  it('is reactive: changing a source cell changes extracted values + signature', () => {
    const chart = makeChart({ range: 'A1:B3', options: { headerRow: true, headerCol: true } })
    const before = wb({ '0_1': 'Sales', '1_0': 'N', '1_1': 10, '2_0': 'S', '2_1': 20 })
    const after  = wb({ '0_1': 'Sales', '1_0': 'N', '1_1': 99, '2_0': 'S', '2_1': 20 })
    const sigBefore = chartValuesSignature(chart, before[0])
    const sigAfter  = chartValuesSignature(chart, after[0])
    expect(sigBefore).not.toBe(sigAfter)
    expect(extractChartData(chart, before[0]).series[0].values).toEqual([10, 20])
    expect(extractChartData(chart, after[0]).series[0].values).toEqual([99, 20])
  })

  it('signature does NOT change when an out-of-range cell changes (perf memo)', () => {
    const chart = makeChart({ range: 'A1:B3', options: { headerRow: true, headerCol: true } })
    const base   = wb({ '0_1': 'S', '1_0': 'N', '1_1': 10, '2_0': 'S', '2_1': 20 })
    const offRng = wb({ '0_1': 'S', '1_0': 'N', '1_1': 10, '2_0': 'S', '2_1': 20, '50_50': 'far away' })
    expect(chartValuesSignature(chart, base[0])).toBe(chartValuesSignature(chart, offRng[0]))
  })

  it('coerces non-numeric cells to 0 and marks all-zero as empty', () => {
    const chart = makeChart({ range: 'A1:B2', options: { headerRow: false, headerCol: false } })
    const data = wb({ '0_0': 'x', '0_1': 'y', '1_0': 'p', '1_1': 'q' })
    const out = extractChartData(chart, data[0])
    expect(out.empty).toBe(true)
  })
})

describe('security — untrusted cell labels never inject', () => {
  it('escapeChartText neutralises formula triggers and strips markup-as-text', () => {
    expect(escapeChartText('=HYPERLINK("javascript:alert(1)","x")').startsWith("'=")).toBe(true)
    expect(escapeChartText('+SUM(1)').startsWith("'+")).toBe(true)
    expect(escapeChartText('@cmd').startsWith("'@")).toBe(true)
    // markup is returned as plain text (renderer escapes via SVG <text>);
    // escapeChartText itself does not build HTML — it just returns a string.
    const s = escapeChartText('<script>alert(1)</script>')
    expect(typeof s).toBe('string')
    expect(s).toContain('<script>')   // literal text, not stripped-to-markup
  })

  it('a <script>/=HYPERLINK cell used as a chart label stays plain data', () => {
    const data = wb({
      '0_0': 'Cat', '0_1': '<script>alert(1)</script>',
      '1_0': '=HYPERLINK("javascript:evil")', '1_1': 5,
    })
    const chart = makeChart({ range: 'A1:B2', options: { headerRow: true, headerCol: true } })
    const out = extractChartData(chart, data[0])
    // series name came from a <script> cell — it is a plain string, escaped
    expect(out.series[0].name).toContain('<script>')
    // category came from an =HYPERLINK cell — neutralised with a leading quote
    expect(out.categories[0].startsWith("'=")).toBe(true)
    // the whole extracted structure is JSON — no functions, no HTML nodes
    expect(() => JSON.stringify(out)).not.toThrow()
  })

  it('accessible summary is plain text', () => {
    const data = wb({ '0_1': 'S', '1_0': 'N', '1_1': 10, '2_0': 'S', '2_1': 20 })
    const chart = makeChart({ range: 'A1:B3', title: 'Sales', options: { headerRow: true, headerCol: true } })
    const summary = chartAccessibleSummary(chart, extractChartData(chart, data[0]))
    expect(summary).toContain('chart')
    expect(typeof summary).toBe('string')
  })
})

describe('delete / update immutability', () => {
  it('updateChart patches by id without mutating the source', () => {
    const data = insertChart(wb(), { id: 'c1', type: 'bar', range: 'A1:B2' })
    const next = updateChart(data, 'c1', { title: 'New', type: 'line' })
    expect(getCharts(next)[0].title).toBe('New')
    expect(getCharts(next)[0].type).toBe('line')
    expect(getCharts(data)[0].title).toBe('')   // original untouched
  })

  it('deleteChart removes only the target chart', () => {
    let data = insertChart(wb(), { id: 'a', range: 'A1:B2' })
    data = insertChart(data, { id: 'b', range: 'C1:D2' })
    const next = deleteChart(data, 'a')
    expect(getCharts(next).map((c) => c.id)).toEqual(['b'])
    expect(getCharts(data)).toHaveLength(2)      // original untouched
  })
})

// ── WAVE-61: chart persistence merge (the data-loss fix core) ────────────────
// FortuneSheet's onChange re-emits normalised sheet objects that DROP the
// app-owned `sheet.charts` field. chartsBySheetId snapshots the authoritative
// charts; mergeCharts re-attaches them to the normalised payload so a local
// edit never clobbers them.
describe('WAVE-61 chart persistence merge', () => {
  // A normalised FortuneSheet payload: a real onChange strips `charts` but keeps
  // sheet identity (id) + celldata.
  function normalised(cells = {}, id = 'sheet_1') {
    const [wbSheet] = wb(cells)
    return [{ ...wbSheet, id }]  // note: NO `charts` field (as FortuneSheet emits)
  }

  it('chartsBySheetId indexes the authoritative charts by sheet id', () => {
    let data = insertChart(wb({ '1_1': 10 }), { id: 'c1', range: 'A1:B2' })
    data = data.map((s, i) => (i === 0 ? { ...s, id: 'sheet_1' } : s))
    const map = chartsBySheetId(data)
    expect(map.get('sheet_1')).toHaveLength(1)
    expect(map.get('sheet_1')![0].id).toBe('c1')
  })

  it('mergeCharts re-attaches charts a normalised onChange payload dropped', () => {
    // Authoritative prior state has a chart on sheet_1.
    let prev = insertChart(wb({ '1_1': 10 }), { id: 'c1', range: 'A1:B2' })
    prev = prev.map((s, i) => (i === 0 ? { ...s, id: 'sheet_1' } : s))
    // FortuneSheet emits a normalised payload with the SAME sheet id but no charts.
    const payload = normalised({ '1_1': 42 }, 'sheet_1')
    expect(getCharts(payload)).toHaveLength(0)   // the bug: charts gone

    const merged = mergeCharts(payload, chartsBySheetId(prev))
    // Charts survive; the fresh cell edit (42) survives too.
    expect(getCharts(merged)).toHaveLength(1)
    expect(getCharts(merged)[0].id).toBe('c1')
    const cell = merged![0].celldata!.find((c) => c.r === 1 && c.c === 1)
    expect(asCellValue(cell!.v).v).toBe(42)
  })

  it('mergeCharts matches by position when the sheet id changed (index #0 fallback)', () => {
    let prev = insertChart(wb(), { id: 'c1', range: 'A1:B2' })  // no id → positional
    const payload = normalised({}, undefined) // id undefined
    const merged = mergeCharts(payload, chartsBySheetId(prev))
    expect(getCharts(merged)).toHaveLength(1)
    expect(getCharts(merged)[0].id).toBe('c1')
  })

  it('mergeCharts is a no-op when there are no authoritative charts', () => {
    const payload = normalised({ '0_0': 'x' }, 'sheet_1')
    const merged = mergeCharts(payload, chartsBySheetId(wb({ '0_0': 'x' })))
    expect(merged).toBe(payload) // empty map → returns the input untouched
  })

  it('mergeCharts does NOT override charts the payload already carries (authoritative update)', () => {
    let prev = insertChart(wb(), { id: 'old', range: 'A1:B2' })
    prev = prev.map((s, i) => (i === 0 ? { ...s, id: 'sheet_1' } : s))
    // A chart-authoritative payload (e.g. a delete leaving a different set).
    let payload = insertChart(normalised({}, 'sheet_1'), { id: 'new', range: 'C1:D2' })
    const merged = mergeCharts(payload, chartsBySheetId(prev))
    // The payload's own charts win — the previous 'old' chart is NOT re-added.
    expect(getCharts(merged).map((c) => c.id)).toEqual(['new'])
  })

  it('clampCharts re-clamps a corrupt local descriptor so render cannot see NaN', () => {
    // Simulate a corrupt persisted chart (non-finite geometry, bad type).
    const corrupt = [{ name: 'Sheet1', celldata: [], config: {}, charts: [
      { id: 'c1', type: 'evil', range: 'A1:B2', title: 't', x: NaN, y: Infinity, w: -1, h: 'x' },
    ] }]
    const fixed = clampCharts(corrupt as unknown as ChartSheet[])
    const c = getCharts(fixed)[0]
    expect(c.type).toBe('column')
    expect(Number.isFinite(c.x) && Number.isFinite(c.y)).toBe(true)
    expect(c.w).toBeGreaterThanOrEqual(160)
    expect(c.h).toBeGreaterThanOrEqual(120)
    expect(c.id).toBe('c1')
  })

  it('clampCharts leaves a well-formed chart intact + is a no-op with no charts', () => {
    const good = insertChart(wb(), { id: 'c1', type: 'bar', range: 'A1:B2' })
    expect(getCharts(clampCharts(good))[0]).toEqual(getCharts(good)[0])
    const none = wb({ '0_0': 'x' })
    expect(clampCharts(none)).toBe(none)
  })
})

// ── WAVE-62: untrusted LOAD paths must clamp a poisoned charts array ──────────
// The trusted-local mergeCharts path deliberately does NOT re-run makeChart on
// every keystroke; correctness of that shortcut RELIES on the invariant that
// every chart ENTERING sheet.charts already passed makeChart — i.e. every
// untrusted-origin load path (initial useState, api.getFile, XLSX import, AND
// draft-restore) funnels content through clampCharts. This suite pins the
// load-path clamp against a maliciously-crafted persisted document: a chart
// with an OBJECT title (→ "Objects are not valid as a React child" render
// crash) and NON-FINITE geometry (→ NaN SVG layout) — the exact wave-55 DoS
// class, reached through the load door instead of the CRDT peer door.
describe('WAVE-62 load-path clamp neutralises a poisoned saved/draft document', () => {
  // A poisoned persisted first sheet: charts array an attacker who can write the
  // file/draft JSON could craft. None of these fields passed makeChart.
  const poisoned = () => [{
    name: 'Sheet1', id: 'sheet_1', celldata: [], config: {},
    charts: [{
      id: 'evil',
      type: '__proto__',                        // not in allow-list
      range: 'A1:B2',
      title: { toString: () => 'boom' },        // OBJECT title → React-child crash
      options: { xAxisLabel: {}, legend: 'yes' },
      x: NaN, y: Infinity, w: -1e9, h: 'nope',  // non-finite geometry → NaN layout
    }],
  }]

  it('clampCharts coerces every hostile field to safe plain data', () => {
    const safe = getCharts(clampCharts(poisoned() as unknown as ChartSheet[]))[0]
    expect(safe.type).toBe('column')                 // unknown type → default
    expect(typeof safe.title).toBe('string')         // object title → string
    expect(safe.title).toBe('')                       // ('' — not the object)
    expect(typeof safe.options.xAxisLabel).toBe('string')
    expect(Number.isFinite(safe.x) && Number.isFinite(safe.y)).toBe(true)
    expect(Number.isFinite(safe.w) && Number.isFinite(safe.h)).toBe(true)
    expect(safe.w).toBeGreaterThanOrEqual(160)
    expect(safe.h).toBeGreaterThanOrEqual(120)
    // Whole descriptor is now pure serialisable data — render-safe.
    expect(JSON.parse(JSON.stringify(safe))).toEqual(safe)
  })

  it('a title that is NOT a string never survives the load clamp (React-child crash guard)', () => {
    for (const badTitle of [{}, [], { toString: () => 'x' }, 42, true, null]) {
      const doc = [{ name: 'Sheet1', id: 's', celldata: [], config: {},
        charts: [{ id: 'c', type: 'bar', range: 'A1:B2', title: badTitle }] }]
      const t = getCharts(clampCharts(doc as unknown as ChartSheet[]))[0].title
      expect(typeof t).toBe('string')   // ALWAYS a string → safe as a React child
    }
  })

  it('mergeCharts trusts its input — proving clamp MUST happen at load, not merge', () => {
    // Documents WHY the draft-restore path had to clamp: mergeCharts re-attaches
    // the in-memory (already-validated) charts verbatim, so if a poisoned array
    // ever reached `data` unclamped, mergeCharts would faithfully preserve the
    // poison on the next keystroke. The clamp is the load-boundary's job.
    const poison = poisoned()
    const payload = [{ name: 'Sheet1', id: 'sheet_1', celldata: [], config: {} }] // no charts
    const merged = mergeCharts(payload, chartsBySheetId(poison as unknown as ChartSheet[]))
    // mergeCharts re-attaches the SAME (unvalidated) object — hence load must clamp.
    expect(getCharts(merged)[0].title).toEqual(poison[0].charts[0].title)
    // ...whereas clamping the source first yields a render-safe descriptor.
    const mergedSafe = mergeCharts(payload, chartsBySheetId(clampCharts(poison as unknown as ChartSheet[])))
    expect(typeof getCharts(mergedSafe)[0].title).toBe('string')
  })
})

// ── WAVE-64: new chart types + their options ────────────────────────────────

describe('WAVE-64 chart types', () => {
  it('every new type is accepted by makeChart and survives the clamp', () => {
    for (const type of ['column-stacked', 'bar-stacked', 'column-100', 'bar-100', 'donut', 'histogram']) {
      expect(makeChart({ type }).type).toBe(type)
      expect(CHART_TYPES.some((t) => t.value === type)).toBe(true)
    }
  })

  it('CHART_TYPE_GROUPS covers every type exactly once (the wizard picker source)', () => {
    const flat = CHART_TYPE_GROUPS.flatMap((g) => g.types.map((t) => t.value))
    expect(flat.sort()).toEqual(CHART_TYPES.map((t) => t.value).sort())
    expect(new Set(flat).size).toBe(CHART_TYPES.length)
  })

  it('stackModeOf / isHorizontalBar classify the family correctly', () => {
    expect(stackModeOf('column-stacked')).toBe('stacked')
    expect(stackModeOf('bar-stacked')).toBe('stacked')
    expect(stackModeOf('column-100')).toBe('percent')
    expect(stackModeOf('bar-100')).toBe('percent')
    expect(stackModeOf('column')).toBe('none')
    expect(stackModeOf('pie')).toBe('none')
    expect(stackModeOf('evil')).toBe('none')          // unknown → never claims to stack
    expect(isHorizontalBar('bar')).toBe(true)
    expect(isHorizontalBar('bar-100')).toBe(true)
    expect(isHorizontalBar('column-100')).toBe(false)
  })

  // THE CLAMP IS THE SECURITY BOUNDARY: a hostile CRDT peer / corrupt file may
  // set ANY field. Every new option must come out of makeChart as safe plain data.
  it('makeChart clamps the NEW options fail-closed (bins / secondaryAxis / y2 label)', () => {
    const hostile = makeChart({
      type: 'histogram',
      options: {
        bins: 1e9,                               // absurd → clamped
        secondaryAxis: 'yes',                    // truthy-but-not-true → false
        y2AxisLabel: { toString: () => 'boom' }, // object → ''
      },
    })
    expect(hostile.options.bins).toBe(50)                 // upper bound
    expect(hostile.options.secondaryAxis).toBe(false)     // explicit opt-in only
    expect(hostile.options.y2AxisLabel).toBe('')
    expect(JSON.parse(JSON.stringify(hostile))).toEqual(hostile)

    // Non-finite / negative / fractional bin counts can never reach the renderer.
    expect(makeChart({ options: { bins: NaN } }).options.bins).toBe(10)      // default
    expect(makeChart({ options: { bins: -5 } }).options.bins).toBe(2)        // lower bound
    expect(makeChart({ options: { bins: Infinity } }).options.bins).toBe(10)
    expect(makeChart({ options: { bins: 7.6 } }).options.bins).toBe(8)       // integral
    expect(makeChart({ options: { bins: '12' } }).options.bins).toBe(12)
    // secondaryAxis is a strict boolean opt-in.
    expect(makeChart({ options: { secondaryAxis: true } }).options.secondaryAxis).toBe(true)
    for (const v of [1, 'true', {}, [], null, undefined]) {
      expect(makeChart({ options: { secondaryAxis: v } }).options.secondaryAxis).toBe(false)
    }
    // A long secondary-axis label is capped like every other free-text field.
    expect(makeChart({ options: { y2AxisLabel: 'y'.repeat(999) } }).options.y2AxisLabel.length).toBe(120)
  })

  it('the memo signature moves when bins / secondaryAxis change (no stale chart)', () => {
    const sheet = wb({ '0_0': 'C', '0_1': 'V', '1_0': 'a', '1_1': 3, '2_0': 'b', '2_1': 9 })[0]
    const base = makeChart({ type: 'histogram', range: 'A1:B3', options: { bins: 5 } })
    const more = makeChart({ ...base, options: { ...base.options, bins: 12 } })
    expect(chartValuesSignature(more, sheet)).not.toBe(chartValuesSignature(base, sheet))
    const combo = makeChart({ type: 'combo', range: 'A1:B3' })
    const combo2 = makeChart({ ...combo, options: { ...combo.options, secondaryAxis: true } })
    expect(chartValuesSignature(combo2, sheet)).not.toBe(chartValuesSignature(combo, sheet))
  })
})

describe('histogramBins', () => {
  it('bins values into equal-width buckets, the max landing in the last one', () => {
    const { bins, max, total } = histogramBins([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5)
    expect(bins).toHaveLength(5)
    expect(total).toBe(10)
    expect(bins.reduce((a, b) => a + b.count, 0)).toBe(10)   // nothing dropped
    expect(bins[0].x0).toBe(1)
    expect(bins[4].x1).toBe(10)
    expect(bins[4].count).toBeGreaterThan(0)                 // 10 is IN the last bin
    expect(max).toBe(Math.max(...bins.map((b) => b.count)))
  })

  it('handles a degenerate range (all values equal) without dividing by zero', () => {
    const { bins, total } = histogramBins([5, 5, 5], 4)
    expect(total).toBe(3)
    expect(bins.reduce((a, b) => a + b.count, 0)).toBe(3)
    expect(bins.every((b) => isFinite(b.x0) && isFinite(b.x1))).toBe(true)
  })

  it('drops non-numeric values and returns an empty result for no numbers', () => {
    expect(histogramBins(['a', null, undefined, NaN], 5).bins).toEqual([])
    expect(histogramBins([], 5).total).toBe(0)
    const mixed = histogramBins([1, 'x', 3, null, 5], 2)
    expect(mixed.total).toBe(3)
  })

  it('clamps a hostile bin count instead of looping unboundedly', () => {
    expect(histogramBins([1, 2, 3], 1e9).bins).toHaveLength(50)
    expect(histogramBins([1, 2, 3], -10).bins).toHaveLength(2)
    expect(histogramBins([1, 2, 3], NaN).bins).toHaveLength(10)
    expect(histogramBins([1, 2, 3], 0).bins).toHaveLength(10)
  })

  // DATA-INTEGRITY: a blank row inside the range is NOT a zero. extractChartData
  // 0-fills blanks so a cartesian plot keeps one point per category, but a
  // histogram binning that shape would invent a spike at 0 for every empty row.
  it('a histogram ignores blank rows instead of counting them as zeros', () => {
    const sheet = wb({
      '0_0': 'V', '1_0': 10, '2_0': 12, '3_0': 11,
      // rows 4..8 of the range are EMPTY
      '9_0': 90,
    })[0]
    const chart = makeChart({ type: 'histogram', range: 'A1:A10', options: { headerRow: true, headerCol: false, bins: 4 } })
    const extracted = extractChartData(chart, sheet)
    // The plotting shape still has a point per row (0-filled)…
    expect(extracted.series[0].values).toHaveLength(9)
    // …but only the REAL numbers are binned.
    expect(histogramValues(extracted)).toEqual([10, 12, 11, 90])
    const { total, bins } = histogramBins(histogramValues(extracted), chart.options.bins)
    expect(total).toBe(4)
    expect(bins.reduce((a, b) => a + b.count, 0)).toBe(4)
  })

  it('negative values bin correctly (the range is not assumed positive)', () => {
    const { bins, total } = histogramBins([-10, -5, 0, 5, 10], 5)
    expect(total).toBe(5)
    expect(bins[0].x0).toBe(-10)
    expect(bins.reduce((a, b) => a + b.count, 0)).toBe(5)
  })
})

describe('chartAccessibleSummary — new types describe themselves', () => {
  const sheet = wb({ '0_0': 'C', '0_1': 'A', '0_2': 'B', '1_0': 'x', '1_1': 3, '1_2': 4, '2_0': 'y', '2_1': 9, '2_2': 1 })[0]

  it('says a stacked chart is stacked (a screen reader must not think it is grouped)', () => {
    const c = makeChart({ type: 'column-stacked', range: 'A1:C3', title: 'S' })
    expect(chartAccessibleSummary(c, extractChartData(c, sheet))).toMatch(/stacked/i)
    const p = makeChart({ type: 'bar-100', range: 'A1:C3', title: 'P' })
    expect(chartAccessibleSummary(p, extractChartData(p, sheet))).toMatch(/100%/)
  })

  it('describes a histogram as a distribution, not as categories', () => {
    const h = makeChart({ type: 'histogram', range: 'B1:B3', title: 'H', options: { headerRow: true, headerCol: false, bins: 3 } })
    const s = chartAccessibleSummary(h, extractChartData(h, sheet))
    expect(s).toMatch(/bins/i)
    expect(s).toMatch(/Histogram/i)
  })

  it('announces a combo secondary axis', () => {
    const c = makeChart({ type: 'combo', range: 'A1:C3', title: 'C', options: { secondaryAxis: true } })
    expect(chartAccessibleSummary(c, extractChartData(c, sheet))).toMatch(/secondary axis/i)
  })
})
