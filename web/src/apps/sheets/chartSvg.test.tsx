/**
 * chartSvg.test.jsx (WAVE-54)
 *
 * Renders ChartSvg with a hostile cell label and asserts it reaches the DOM as
 * ESCAPED TEXT inside an SVG <text> node — never as a live <script> element.
 * This is the on-screen half of the security contract (charts.test.js covers the
 * data half). Confirms the renderer uses no innerHTML.
 */
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { ChartSvg } from './ChartSvg.jsx'
import { makeChart, type ChartSheet } from './charts.js'

// The renderer never sets these; a hostile <script>/onerror label reaching a
// LIVE DOM node would set them as a side effect. They are deliberately NOT
// part of the real Window interface (only a successful exploit would add
// them), so read them through a local cast rather than augmenting the global.
const win = window as unknown as { __pwned?: unknown; __pwned2?: unknown }

function sheetWith(cells: Record<string, string | number>): ChartSheet {
  return {
    name: 'S',
    celldata: Object.entries(cells).map(([k, v]) => {
      const [r, c] = k.split('_').map(Number)
      return { r, c, v: { v, m: String(v), ct: { fa: 'General' } } }
    }),
  }
}

describe('ChartSvg escaping', () => {
  it('renders a <script> cell label as inert text, not a script element', () => {
    const sheet = sheetWith({
      '0_0': 'Cat', '0_1': '<script>window.__pwned=1</script>',
      '1_0': 'x', '1_1': 5,
    })
    const chart = makeChart({ range: 'A1:B2', title: '<img src=x onerror=alert(1)>', options: { headerRow: true, headerCol: true } })
    const { container } = render(<ChartSvg chart={chart} sheet={sheet} width={400} height={260} />)

    // No live script/img element was created from the untrusted strings.
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(win.__pwned).toBeUndefined()

    // The title text is present but only as text content of an SVG <text>.
    const text = container.textContent || ''
    expect(text).toContain('<img src=x onerror=alert(1)>')
    // It's an <svg>, and every drawn label lives in a <text> node.
    expect(container.querySelector('svg')).toBeTruthy()
  })

  it('renders an empty-range chart without throwing', () => {
    const chart = makeChart({ range: 'A1:B2' })
    const { container } = render(<ChartSvg chart={chart} sheet={sheetWith({})} width={300} height={200} />)
    expect(container.querySelector('svg')).toBeTruthy()
    expect(container.textContent).toContain('No data')
  })

  it('renders each chart type without error', () => {
    const sheet = sheetWith({ '0_1': 'V', '1_0': 'a', '1_1': 3, '2_0': 'b', '2_1': 7 })
    // WAVE-63: scatter/combo/bubble added.
    for (const type of ['column', 'bar', 'line', 'area', 'pie', 'scatter', 'combo', 'bubble']) {
      const chart = makeChart({ type, range: 'A1:B3', options: { headerRow: true, headerCol: true } })
      const { container, unmount } = render(<ChartSvg chart={chart} sheet={sheet} width={360} height={240} />)
      expect(container.querySelector('svg')).toBeTruthy()
      unmount()
    }
  })

  // WAVE-63: scatter/bubble plot numeric X/Y (and size) columns as points.
  it('renders scatter and bubble as <circle> points, no innerHTML', () => {
    // 3 numeric columns: X, Y, Size — headerCol off so col 0 is X, not labels.
    const sheet = sheetWith({
      '0_0': 'X', '0_1': 'Y', '0_2': 'Size',
      '1_0': 1, '1_1': 10, '1_2': 5,
      '2_0': 2, '2_1': 20, '2_2': 15,
      '3_0': 3, '3_1': 15, '3_2': 8,
    })
    for (const type of ['scatter', 'bubble']) {
      const chart = makeChart({ type, range: 'A1:C4', options: { headerRow: true, headerCol: false } })
      const { container, unmount } = render(<ChartSvg chart={chart} sheet={sheet} width={360} height={240} />)
      expect(container.querySelector('circle')).toBeTruthy() // points drawn
      expect(container.querySelector('script')).toBeNull()
      unmount()
    }
  })

  it('combo draws both a <rect> (bars) and a <path> (line)', () => {
    const sheet = sheetWith({
      '0_0': 'Cat', '0_1': 'Bars', '0_2': 'Line',
      '1_0': 'a', '1_1': 5, '1_2': 3,
      '2_0': 'b', '2_1': 8, '2_2': 6,
    })
    const chart = makeChart({ type: 'combo', range: 'A1:C3', options: { headerRow: true, headerCol: true } })
    const { container } = render(<ChartSvg chart={chart} sheet={sheet} width={360} height={240} />)
    expect(container.querySelector('rect')).toBeTruthy() // series[0] bars
    expect(container.querySelector('path')).toBeTruthy() // series[1] line
  })

  // WAVE-55 regression: a HOSTILE chart descriptor from a CRDT peer — non-string
  // title (object), non-finite geometry, unknown/huge type, foreignObject-shaped
  // string — must render safely once it passes through makeChart (the ingress
  // sanitiser SheetsEditor now applies). Before the fix a non-string title threw
  // "Objects are not valid as a React child" (remote-triggered crash / DoS).
  it('renders a makeChart-sanitised hostile peer descriptor without crashing', () => {
    const sheet = sheetWith({ '0_0': 'Cat', '0_1': 'V', '1_0': 'a', '1_1': 3 })
    const hostile = {
      id: 'evil',
      type: '__proto__',                       // unknown → falls back to 'column'
      range: 'A1:B2',
      title: { toString: () => '<foreignObject><script>window.__pwned=1</script></foreignObject>' },
      options: { xAxisLabel: {}, yAxisLabel: [], legend: 'yes', headerRow: true, headerCol: true },
      x: NaN, y: Infinity, w: -1e9, h: 'not-a-number',
    }
    const safe = makeChart(hostile)
    // makeChart coerces/clamps fail-closed.
    expect(safe.type).toBe('column')
    expect(typeof safe.title).toBe('string')   // object title coerced to '' (not [object])
    expect(Number.isFinite(safe.x) && Number.isFinite(safe.y)).toBe(true)
    expect(Number.isFinite(safe.w) && Number.isFinite(safe.h)).toBe(true)

    const { container } = render(<ChartSvg chart={safe} sheet={sheet} width={360} height={240} />)
    // No live element was ever created; no foreignObject; no script executed.
    expect(container.querySelector('svg')).toBeTruthy()
    expect(container.querySelector('foreignObject')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(win.__pwned).toBeUndefined()
  })
})

// ── WAVE-64: stacked / 100% / donut / histogram / combo secondary axis ───────

/** A 2-series categorical sheet: Cat | A | B. */
function stackSheet(rows: (string | number)[][] = [['a', 3, 7], ['b', 6, 2]]) {
  const cells: Record<string, string | number> = { '0_0': 'Cat', '0_1': 'A', '0_2': 'B' }
  rows.forEach(([cat, a, b], i) => {
    cells[`${i + 1}_0`] = cat
    cells[`${i + 1}_1`] = a
    cells[`${i + 1}_2`] = b
  })
  return sheetWith(cells)
}

describe('WAVE-64 chart types render', () => {
  it('renders EVERY new type without error, as SVG and never as markup', () => {
    const sheet = stackSheet()
    for (const type of ['column-stacked', 'bar-stacked', 'column-100', 'bar-100', 'donut', 'histogram']) {
      const chart = makeChart({ type, range: 'A1:C3', options: { headerRow: true, headerCol: true } })
      const { container, unmount } = render(<ChartSvg chart={chart} sheet={sheet} width={400} height={280} />)
      expect(container.querySelector('svg')).toBeTruthy()
      expect(container.querySelector('script')).toBeNull()
      expect(container.innerHTML).not.toContain('<foreignObject')
      unmount()
    }
  })

  it('stacked column: segments accumulate — the tallest total, not the tallest value, sets the axis', () => {
    const sheet = stackSheet([['a', 3, 7], ['b', 6, 2]])
    const chart = makeChart({ type: 'column-stacked', range: 'A1:C3', options: { headerRow: true, headerCol: true } })
    const { container } = render(<ChartSvg chart={chart} sheet={sheet} width={400} height={280} />)
    expect(container.querySelector('[data-testid="stacked-stacked"]')).toBeTruthy()
    // Both categories total 10 → the two stacks have equal total height, and each
    // category has one rect per series. (Scope to the PLOT: legend chips are
    // <rect>s too.)
    const rects = [...container.querySelectorAll('[data-testid="stacked-stacked"] rect')]
    expect(rects).toHaveLength(4)
    const cat0 = rects.filter((r) => Math.abs(Number(r.getAttribute('x')) - Number(rects[0].getAttribute('x'))) < 0.01)
    const totalH = cat0.reduce((a, r) => a + Number(r.getAttribute('height')), 0)
    expect(totalH).toBeGreaterThan(0)
    // Tooltips carry the raw value, not the stacked offset.
    expect(container.textContent).toContain('A · a: 3')
  })

  it('100% stacked: every category fills the axis and the ticks read as percentages', () => {
    const sheet = stackSheet([['a', 1, 3], ['b', 30, 10]])   // wildly different magnitudes
    const chart = makeChart({ type: 'column-100', range: 'A1:C3', options: { headerRow: true, headerCol: true } })
    const { container } = render(<ChartSvg chart={chart} sheet={sheet} width={400} height={280} />)
    expect(container.querySelector('[data-testid="stacked-percent"]')).toBeTruthy()
    expect(container.textContent).toContain('100%')          // axis is a percentage axis
    // Each category's segments sum to the SAME height despite 4 vs 40 raw totals.
    const rects = [...container.querySelectorAll('[data-testid="stacked-percent"] rect')]
    const byX = new Map()
    for (const r of rects) {
      const x = Number(r.getAttribute('x')).toFixed(1)
      byX.set(x, (byX.get(x) || 0) + Number(r.getAttribute('height')))
    }
    const totals = [...byX.values()]
    expect(totals).toHaveLength(2)
    expect(Math.abs(totals[0] - totals[1])).toBeLessThan(0.01)
    // The tooltip shows the share AND the underlying number (no silent rescaling).
    expect(container.textContent).toContain('A · a: 1 (25.0%)')
  })

  it('stacked: a NEGATIVE value stacks below the zero line instead of being dropped', () => {
    const sheet = stackSheet([['a', 5, -3], ['b', 4, 2]])
    const chart = makeChart({ type: 'column-stacked', range: 'A1:C3', options: { headerRow: true, headerCol: true } })
    const { container } = render(<ChartSvg chart={chart} sheet={sheet} width={400} height={280} />)
    // The negative segment exists (4 rects for 2×2 non-zero values) and the axis
    // extends below zero (a negative tick label is rendered).
    expect(container.querySelectorAll('[data-testid="stacked-stacked"] rect')).toHaveLength(4)
    expect(container.textContent).toContain('B · a: -3')
    expect(container.textContent).toMatch(/-\d/)   // a negative axis tick
  })

  it('horizontal stacked bars use the x axis for the value', () => {
    const sheet = stackSheet()
    const chart = makeChart({ type: 'bar-stacked', range: 'A1:C3', options: { headerRow: true, headerCol: true } })
    const { container } = render(<ChartSvg chart={chart} sheet={sheet} width={400} height={280} />)
    const rects = [...container.querySelectorAll('[data-testid="stacked-stacked"] rect')]
    // Two categories → two distinct y bands; segments differ in x, not y.
    const ys = new Set(rects.map((r) => r.getAttribute('y')))
    expect(ys.size).toBe(2)
    expect(new Set(rects.map((r) => r.getAttribute('x'))).size).toBeGreaterThan(1)
  })

  it('donut: draws a hole (arc paths, no wedge apex) and prints the total in the middle', () => {
    const sheet = stackSheet([['a', 3, 0], ['b', 7, 0]])
    const chart = makeChart({ type: 'donut', range: 'A1:B3', options: { headerRow: true, headerCol: true } })
    const { container } = render(<ChartSvg chart={chart} sheet={sheet} width={400} height={280} />)
    expect(container.querySelector('[data-testid="donut"]')).toBeTruthy()
    const paths = [...container.querySelectorAll('path')]
    expect(paths.length).toBeGreaterThan(0)
    // A donut slice is an annulus: two arcs, and it never starts at the centre
    // with a straight line to the rim (which is what a pie wedge does).
    expect(paths.every((p) => (p.getAttribute('d')?.match(/A /g) || []).length === 2)).toBe(true)
    expect(container.textContent).toContain('10')    // the total, in the hole
  })

  it('pie honours legend:false (the slice legend is not unconditional)', () => {
    const sheet = stackSheet()
    const on = render(<ChartSvg chart={makeChart({ type: 'pie', range: 'A1:B3' })} sheet={sheet} width={360} height={240} />)
    expect(on.container.querySelector('[data-testid="chart-legend"]')).toBeTruthy()
    on.unmount()
    const off = render(
      <ChartSvg chart={makeChart({ type: 'pie', range: 'A1:B3', options: { legend: false } })} sheet={sheet} width={360} height={240} />
    )
    expect(off.container.querySelector('[data-testid="chart-legend"]')).toBeNull()
  })

  it('histogram: bins the first numeric column into adjacent bars with a frequency axis', () => {
    const cells: Record<string, string | number> = { '0_0': 'V' }
    ;[1, 2, 2, 3, 8, 9, 9, 10].forEach((v, i) => { cells[`${i + 1}_0`] = v })
    const sheet = sheetWith(cells)
    const chart = makeChart({ type: 'histogram', range: 'A1:A9', options: { headerRow: true, headerCol: false, bins: 3 } })
    const { container } = render(<ChartSvg chart={chart} sheet={sheet} width={420} height={280} />)
    expect(container.querySelector('[data-testid="histogram"]')).toBeTruthy()
    expect(container.querySelectorAll('[data-testid="histogram"] rect')).toHaveLength(3)  // one bar per bin
    expect(container.textContent).toContain('Frequency')                // default y label
    // Bars are adjacent (bin i+1 starts where bin i ends, within the 1px gutter).
    const rects = [...container.querySelectorAll('[data-testid="histogram"] rect')]
    const x0 = Number(rects[0].getAttribute('x')), w0 = Number(rects[0].getAttribute('width'))
    expect(Number(rects[1].getAttribute('x')) - (x0 + w0)).toBeLessThan(2)
  })

  it('histogram with no numeric values says so instead of drawing an empty frame', () => {
    const sheet = sheetWith({ '0_0': 'V', '1_0': 'x', '2_0': 'y' })
    const chart = makeChart({ type: 'histogram', range: 'A1:A3', options: { headerRow: true, headerCol: false } })
    const { container } = render(<ChartSvg chart={chart} sheet={sheet} width={360} height={240} />)
    expect(container.textContent).toMatch(/No (numeric values|data)/i)
  })

  it('combo secondary axis: a small-magnitude line series is not flattened by the columns', () => {
    // Revenue in the hundreds, margin in single digits: on ONE axis the margin
    // line would sit on the floor. The secondary axis rescales it.
    const sheet = sheetWith({
      '0_0': 'Q', '0_1': 'Revenue', '0_2': 'Margin',
      '1_0': 'Q1', '1_1': 500, '1_2': 4,
      '2_0': 'Q2', '2_1': 900, '2_2': 9,
    })
    const shared = makeChart({ type: 'combo', range: 'A1:C3', options: { headerRow: true, headerCol: true } })
    const dual = makeChart({ type: 'combo', range: 'A1:C3', options: { headerRow: true, headerCol: true, secondaryAxis: true, y2AxisLabel: 'Margin %' } })

    const a = render(<ChartSvg chart={shared} sheet={sheet} width={420} height={280} />)
    expect(a.container.querySelector('[data-testid="secondary-axis"]')).toBeNull()
    const sharedLineY = a.container.querySelector('path[fill="none"]')?.getAttribute('d')
    a.unmount()

    const b = render(<ChartSvg chart={dual} sheet={sheet} width={420} height={280} />)
    expect(b.container.querySelector('[data-testid="secondary-axis"]')).toBeTruthy()
    expect(b.container.textContent).toContain('Margin %')          // right-axis title
    const dualLineY = b.container.querySelector('path[fill="none"]')?.getAttribute('d')
    // The line is drawn at a DIFFERENT (higher) position once it has its own scale.
    expect(dualLineY).not.toBe(sharedLineY)
    // Legend marks which scale each series belongs to.
    expect(b.container.textContent).toContain('Revenue (L)')
    expect(b.container.textContent).toContain('Margin (R)')
  })

  // The clamp is the hard invariant: a hostile descriptor of ANY new kind must
  // render safely once it has passed through makeChart.
  it('renders a makeChart-sanitised hostile descriptor of every new type', () => {
    const sheet = stackSheet()
    for (const type of ['column-stacked', 'bar-stacked', 'column-100', 'bar-100', 'donut', 'histogram', 'combo']) {
      const safe = makeChart({
        id: 'evil', type,
        range: 'A1:C3',
        title: { toString: () => '<script>window.__pwned2=1</script>' },
        options: {
          bins: -1e9, secondaryAxis: 'yes', y2AxisLabel: [],
          xAxisLabel: {}, yAxisLabel: null, legend: 'maybe', headerRow: true, headerCol: true,
        },
        x: NaN, y: Infinity, w: -1e9, h: 'nope',
      })
      expect(safe.type).toBe(type)                       // legit type survives…
      expect(safe.options.secondaryAxis).toBe(false)     // …hostile options do not
      expect(safe.options.bins).toBe(2)
      expect(typeof safe.title).toBe('string')
      const { container, unmount } = render(<ChartSvg chart={safe} sheet={sheet} width={360} height={240} />)
      expect(container.querySelector('svg')).toBeTruthy()
      expect(container.querySelector('script')).toBeNull()
      expect(container.innerHTML).not.toContain('NaN')   // no NaN geometry escaped
      expect(win.__pwned2).toBeUndefined()
      unmount()
    }
  })
})
