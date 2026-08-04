/**
 * chartsPersist.test.js  (WAVE-61)
 *
 * Regression harness for the confirmed DATA-LOSS bug: a locally-inserted chart
 * VANISHED on the next cell edit because `<Workbook onChange={handleChange}>`
 * fires with FortuneSheet-normalised sheet objects that DROP the app's custom
 * `sheet.charts` field, so `setData(payload)` clobbered charts on grid init and
 * on every edit (wave-59 finding: 0 [data-chart-id] cards + 0 charts in save).
 *
 * @fortune-sheet's canvas grid can't mount under jsdom, so we model the exact
 * data-flow the editor implements: an authoritative `data` state, a functional
 * `setData`, and the charts merge SheetsEditor.handleChange performs. If the
 * merge regresses, these fail exactly like the E2E did.
 */
import { describe, it, expect } from 'vitest'
import {
  makeChart, insertChart, getCharts, extractChartData,
  chartsBySheetId, mergeCharts, clampCharts,
  type ChartSheet, type ChartInput,
} from './charts.js'

type ChartsAuthoritativeOpts = { chartsAuthoritative?: boolean }

// ── A faithful mini-model of SheetsEditor's data plumbing ────────────────────
// Mirrors the real component: `data` is the authoritative state; handleChange
// merges the app-owned charts back onto the normalised FortuneSheet payload
// (unless the update is chart-authoritative). This is the code under test.
function makeEditor(initialContent: ChartSheet[]) {
  let data: ChartSheet[] | null | undefined = clampCharts(normalizeSheets(initialContent))
  let lastSaved: ChartSheet[] | null | undefined = null
  const saves: (ChartSheet[] | null | undefined)[] = []

  const setData = (updater: ChartSheet[] | null | undefined | ((prev: ChartSheet[] | null | undefined) => ChartSheet[] | null | undefined)) => {
    data = typeof updater === 'function' ? updater(data) : updater
  }

  // Exact port of SheetsEditor.handleChange's charts-merge behaviour.
  const handleChange = (newData: ChartSheet[] | null | undefined, opts: ChartsAuthoritativeOpts = {}) => {
    setData((prev) => {
      if (!Array.isArray(newData)) return newData
      if (opts.chartsAuthoritative) return newData
      return mergeCharts(newData, chartsBySheetId(prev))
    })
    const toSave = (Array.isArray(newData) && !opts.chartsAuthoritative)
      ? mergeCharts(newData, chartsBySheetId(data))  // dataRef.current stand-in
      : newData
    lastSaved = toSave
    saves.push(toSave)
  }

  // handleChartChange marks the update authoritative (wizard/ChartLayer op).
  const handleChartChange = (nextData: ChartSheet[] | null | undefined) => handleChange(nextData, { chartsAuthoritative: true })

  return {
    getData: () => data,
    handleChange,
    handleChartChange,
    getLastSaved: () => lastSaved,
    getSaves: () => saves,
  }
}

// Minimal normalizeSheets (only the fields the merge cares about: id + charts).
function normalizeSheets(sheets: ChartSheet[] | null | undefined): ChartSheet[] {
  const arr = Array.isArray(sheets) && sheets.length ? sheets : [{ name: 'Sheet1', celldata: [], config: {} }]
  return arr.map((sh, i) => ({
    ...sh,
    name: sh.name || `Sheet${i + 1}`,
    celldata: sh.celldata || [],
    config: sh.config || {},
    id: sh.id || `sheet_${i + 1}`,
  }))
}

// A FortuneSheet-style onChange payload: it KEEPS the sheet id + celldata but
// DROPS the app's custom `charts` field (this is the crux of the bug).
function fsPayload(cells: Record<string, string | number>, id = 'sheet_1'): ChartSheet[] {
  const celldata = Object.entries(cells).map(([k, v]) => {
    const [r, c] = k.split('_').map(Number)
    return { r, c, v: { v, m: String(v), ct: { fa: 'General', t: typeof v === 'number' ? 'n' : 'g' } } }
  })
  return [{ name: 'Sheet1', celldata, config: {}, id /* NO charts */ }]
}

describe('WAVE-61 — inserted chart survives a subsequent cell edit', () => {
  it('the EXACT regression: chart stays in `charts` + still renders after a grid edit', () => {
    const ed = makeEditor([{ name: 'Sheet1', celldata: [
      { r: 0, c: 1, v: { v: 'Sales', m: 'Sales' } },
      { r: 1, c: 0, v: { v: 'Q1', m: 'Q1' } }, { r: 1, c: 1, v: { v: 10, m: '10' } },
      { r: 2, c: 0, v: { v: 'Q2', m: 'Q2' } }, { r: 2, c: 1, v: { v: 40, m: '40' } },
    ], config: {} }])

    // 1) User inserts a chart via the wizard (authoritative update).
    ed.handleChartChange(insertChart(ed.getData(), { id: 'c1', type: 'column', range: 'A1:B3', title: 'Sales' }))
    expect(getCharts(ed.getData())).toHaveLength(1)

    // 2) FortuneSheet fires onChange with a normalised, charts-STRIPPED payload
    //    (a cell edit: B2 10 → 99). Pre-fix this clobbered the chart.
    ed.handleChange(fsPayload({ '0_1': 'Sales', '1_0': 'Q1', '1_1': 99, '2_0': 'Q2', '2_1': 40 }))

    // 3) The chart SURVIVED the edit.
    const charts = getCharts(ed.getData())
    expect(charts).toHaveLength(1)
    expect(charts[0].id).toBe('c1')

    // 4) …and it still renders: extractChartData yields the LIVE values,
    //    picking up the edited cell (reactivity intact).
    const out = extractChartData(charts[0], ed.getData()![0])
    expect(out.empty).toBe(false)
    expect(out.series[0].values).toEqual([99, 40]) // reflects the edit
  })

  it('persists the chart into the saved content (charts in the save PUT payload)', () => {
    const ed = makeEditor([{ name: 'Sheet1', celldata: [{ r: 1, c: 1, v: { v: 10, m: '10' } }], config: {} }])
    ed.handleChartChange(insertChart(ed.getData(), { id: 'c1', range: 'A1:B2' }))
    // A later plain cell edit triggers a save with a charts-stripped payload…
    ed.handleChange(fsPayload({ '1_1': 20 }))
    // …but the SAVED content carries the chart (it reloads with the sheet).
    expect(getCharts(ed.getLastSaved())).toHaveLength(1)
    expect(getCharts(ed.getLastSaved())[0].id).toBe('c1')
  })

  it('reloads from saved content: a saved chart re-hydrates into the editor', () => {
    // Save content from one session…
    const ed1 = makeEditor([{ name: 'Sheet1', celldata: [{ r: 1, c: 1, v: { v: 5, m: '5' } }], config: {} }])
    ed1.handleChartChange(insertChart(ed1.getData(), { id: 'c1', range: 'A1:B2', title: 'Reload me' }))
    ed1.handleChange(fsPayload({ '1_1': 5 }))
    const saved = ed1.getLastSaved()

    // …open a fresh editor from that saved content.
    const ed2 = makeEditor(saved!)
    expect(getCharts(ed2.getData())).toHaveLength(1)
    expect(getCharts(ed2.getData())[0].title).toBe('Reload me')
  })

  it('re-renders on a source-cell change (wave-54 reactivity preserved)', () => {
    const ed = makeEditor([{ name: 'Sheet1', celldata: [
      { r: 0, c: 0, v: { v: 5, m: '5' } },
    ], config: {} }])
    ed.handleChartChange(insertChart(ed.getData(), { id: 'c1', range: 'A1:A2', title: 't',
      options: { headerRow: false, headerCol: false } }))
    const before = extractChartData(getCharts(ed.getData())[0], ed.getData()![0])
    expect(before.series[0].values).toEqual([5, 0])

    // Edit the source cell A1: 5 → 77 via a normalised payload.
    ed.handleChange(fsPayload({ '0_0': 77 }))
    const after = extractChartData(getCharts(ed.getData())[0], ed.getData()![0])
    expect(after.series[0].values).toEqual([77, 0]) // chart survived AND re-reads
  })

  it('a chart DELETE is authoritative and is not resurrected by the merge', () => {
    const ed = makeEditor([{ name: 'Sheet1', celldata: [], config: {} }])
    ed.handleChartChange(insertChart(ed.getData(), { id: 'c1', range: 'A1:B2' }))
    expect(getCharts(ed.getData())).toHaveLength(1)
    // Delete: authoritative payload with the chart removed.
    ed.handleChartChange([{ ...ed.getData()![0], charts: [] }])
    expect(getCharts(ed.getData())).toHaveLength(0)
    // A later normalised grid edit must NOT bring the deleted chart back.
    ed.handleChange(fsPayload({ '0_0': 'x' }))
    expect(getCharts(ed.getData())).toHaveLength(0)
  })
})

// ── WAVE-55 preserved: remote (untrusted) chart_op STILL goes through makeChart ─
// The local-merge fix must NOT open a hole in the peer-ingress path. This is the
// exact merge SheetsEditor.onRemote performs for a `chart_op`: a peer descriptor
// is sanitised via makeChart before it touches sheet.charts. A hostile peer must
// not inject a non-string title (React-child crash), non-finite geometry (NaN
// layout / render escape), or an absurd size (DoS).
describe('WAVE-55 chart_op ingress — merge fix keeps the fail-closed clamp', () => {
  // Faithful port of SheetsEditor.onRemote's chart-branch merge.
  type ChartOpDetail = { action: string; chart?: ChartInput; chartId?: string }
  function ingestChartOp(prevData: ChartSheet[] | null | undefined, detail: ChartOpDetail): ChartSheet[] {
    const safeChart = detail.chart ? makeChart(detail.chart) : null
    if (detail.chart && (typeof detail.chart.id !== 'string' || !detail.chart.id)) return prevData ?? []
    return (prevData || []).map((sheet, idx) => {
      if (idx !== 0) return sheet
      const charts = Array.isArray(sheet.charts) ? sheet.charts : []
      if (detail.action === 'delete') return { ...sheet, charts: charts.filter((c) => c.id !== detail.chartId) }
      if (safeChart) {
        const exists = charts.some((c) => c.id === safeChart.id)
        return { ...sheet, charts: exists ? charts.map((c) => (c.id === safeChart.id ? safeChart : c)) : [...charts, safeChart] }
      }
      return sheet
    })
  }

  it('a malicious peer descriptor is clamped by makeChart before merge, not merged raw', () => {
    const base = [{ name: 'Sheet1', celldata: [], config: {} }]
    const hostile = {
      id: 'evil', type: '__proto__',
      title: { toString: () => 'boom' },   // object title → coerced to ''
      options: { xAxisLabel: {}, legend: 'yes' },
      x: NaN, y: Infinity, w: 1e12, h: 'nope',
    }
    const merged = ingestChartOp(base, { action: 'upsert', chart: hostile })
    const c = getCharts(merged)[0]
    // The RAW hostile object was never stored — makeChart clamped every field.
    expect(c.type).toBe('column')
    expect(c.title).toBe('')                       // non-string title neutralised
    expect(c.options.xAxisLabel).toBe('')
    expect(Number.isFinite(c.x) && Number.isFinite(c.y)).toBe(true)
    expect(c.w).toBeLessThanOrEqual(4000)          // absurd size clamped (no DoS)
    expect(c.id).toBe('evil')
    expect(JSON.parse(JSON.stringify(c))).toEqual(c)  // pure serialisable data
    // Prove it is the sanitised object, NOT the hostile input.
    expect(c).not.toBe(hostile)
    expect(typeof c.title).toBe('string')
  })

  it('a peer descriptor with no usable string id is dropped (fail-closed)', () => {
    const base = [{ name: 'Sheet1', celldata: [], config: {} }]
    const merged = ingestChartOp(base, { action: 'upsert', chart: { type: 'bar' /* no id */ } })
    expect(getCharts(merged)).toHaveLength(0)
  })
})
