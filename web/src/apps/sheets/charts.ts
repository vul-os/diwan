/**
 * src/apps/sheets/charts.ts  (WAVE-54)
 *
 * Pure, dependency-free chart model + data extraction for Sheets.
 *
 * A chart is PLAIN STRUCTURED DATA stored on the first sheet as `sheet.charts`
 * (an array). It is NOT a screenshot and NOT HTML — it is a small descriptor:
 *
 *   {
 *     id:      string,                       // stable, unique
 *     type:    'bar'|'column'|'line'|'area'|'pie',
 *     range:   'A1:D10',                     // A1 source range (untrusted text)
 *     title:   string,                       // untrusted (may come from a cell)
 *     options: { xAxisLabel, yAxisLabel, legend, headerRow, headerCol },
 *     x: number, y: number, w: number, h: number   // float position over grid
 *   }
 *
 * Because the descriptor is plain data it round-trips cleanly through the CRDT
 * transport and the file-content save path, and it RE-RENDERS LIVE: the renderer
 * reads the current cell values for `range` every time the underlying cells
 * change (see chartValuesSignature for the memo key).
 *
 * SECURITY (WAVE-14 posture): every string that ends up on screen (title, axis
 * labels, category names, series names) originates from CELL DATA and is treated
 * as untrusted. Nothing here builds HTML. The React renderer emits SVG <text>
 * nodes whose children are escaped text — never innerHTML — so a cell containing
 * `<script>…` or `=HYPERLINK(...)` becomes literal glyphs, never markup or a
 * formula. `escapeChartText` below is a belt-and-braces normaliser used before a
 * value is ever placed into an export string (which then also passes the
 * WAVE-14 sanitizer). No value in a chart descriptor is ever eval'd.
 */

import { parseRange } from './ConditionalFormatPanel.jsx'

export interface ChartTypeMeta {
  value: string
  label: string
  icon: string
  group: string
}

export interface ChartOptions {
  xAxisLabel: string
  yAxisLabel: string
  y2AxisLabel: string
  legend: boolean
  headerRow: boolean
  headerCol: boolean
  secondaryAxis: boolean
  bins: number
}

export interface Chart {
  id: string
  type: string
  range: string
  title: string
  options: ChartOptions
  x: number
  y: number
  w: number
  h: number
}

/** Loose, pre-validation input to `makeChart`. */
export interface ChartInput {
  id?: unknown
  type?: unknown
  range?: unknown
  title?: unknown
  options?: {
    xAxisLabel?: unknown
    yAxisLabel?: unknown
    y2AxisLabel?: unknown
    legend?: unknown
    headerRow?: unknown
    headerCol?: unknown
    secondaryAxis?: unknown
    bins?: unknown
  }
  x?: unknown
  y?: unknown
  w?: unknown
  h?: unknown
}

export interface ChartCellValue {
  v?: string | number | boolean
  m?: string | number
  [key: string]: unknown
}
export interface ChartCellEntry {
  r: number
  c: number
  v?: ChartCellValue | string | number | boolean | null
}
export interface ChartSheet {
  id?: string
  celldata?: ChartCellEntry[]
  charts?: Chart[]
  [key: string]: unknown
}

export interface HistogramBin { x0: number; x1: number; count: number; label: string }
export interface HistogramResult { bins: HistogramBin[]; max: number; total: number }

export interface ChartSeries { name: string; values: number[]; numeric: number[]; color: string }
export interface ExtractedChartData { categories: string[]; series: ChartSeries[]; empty: boolean }

/** The `[{ row: [r0,r1], column: [c0,c1] }]` shape `parseRange` (ConditionalFormatPanel.jsx,
 * not yet converted) always returns — a local, explicit view of its contract. */
interface ParsedRangeRect { row: [number, number]; column: [number, number] }

export const CHART_TYPES: ChartTypeMeta[] = [
  { value: 'column',  label: 'Column',  icon: '▮',  group: 'Bar & column' },
  { value: 'bar',     label: 'Bar',     icon: '▬',  group: 'Bar & column' },
  // WAVE-64 stacking family. Stacking is a property of the PLOT, not of the data,
  // so it is encoded in the type (as Google Sheets does) rather than as a flag —
  // that keeps the descriptor a single allow-listed enum at the CRDT ingress.
  { value: 'column-stacked', label: 'Stacked column', icon: '▥', group: 'Bar & column' },
  { value: 'bar-stacked',    label: 'Stacked bar',    icon: '▤', group: 'Bar & column' },
  { value: 'column-100',     label: '100% column',    icon: '◫', group: 'Bar & column' },
  { value: 'bar-100',        label: '100% bar',       icon: '⊟', group: 'Bar & column' },
  { value: 'line',    label: 'Line',    icon: '╱',  group: 'Line & area' },
  { value: 'area',    label: 'Area',    icon: '△',  group: 'Line & area' },
  // WAVE-63 additional types:
  { value: 'combo',   label: 'Combo',   icon: '▮╱', group: 'Line & area' }, // 1st series bars, rest lines
  { value: 'pie',     label: 'Pie',     icon: '◔',  group: 'Part-to-whole' },
  { value: 'donut',   label: 'Donut',   icon: '◎',  group: 'Part-to-whole' }, // WAVE-64
  { value: 'scatter', label: 'Scatter', icon: '⣿',  group: 'Distribution' },  // X/Y points (2 numeric series)
  { value: 'bubble',  label: 'Bubble',  icon: '◍',  group: 'Distribution' },  // X/Y + size (3 numeric series)
  { value: 'histogram', label: 'Histogram', icon: '▁▄█', group: 'Distribution' }, // WAVE-64 binned frequency
]

const CHART_TYPE_SET = new Set(CHART_TYPES.map((t) => t.value))

export interface ChartTypeGroup { group: string; types: ChartTypeMeta[] }

/** Ordered, de-duplicated type groups (for the wizard's grouped picker). */
export const CHART_TYPE_GROUPS: ChartTypeGroup[] = CHART_TYPES.reduce((acc: ChartTypeGroup[], t) => {
  const g = acc.find((x) => x.group === t.group)
  if (g) g.types.push(t)
  else acc.push({ group: t.group, types: [t] })
  return acc
}, [])

/**
 * stackModeOf — how a cartesian type stacks its series.
 *   'none'    grouped side-by-side bars / independent lines
 *   'stacked' values accumulate; axis max = the largest row TOTAL
 *   'percent' values accumulate, each row normalised to 100%
 * Anything non-cartesian (pie/donut/scatter/bubble/histogram) is 'none'.
 */
export function stackModeOf(type: string): 'none' | 'stacked' | 'percent' {
  if (type === 'column-stacked' || type === 'bar-stacked') return 'stacked'
  if (type === 'column-100' || type === 'bar-100') return 'percent'
  return 'none'
}

/** True for the horizontal-bar family (bar, bar-stacked, bar-100). */
export function isHorizontalBar(type: string): boolean {
  return type === 'bar' || type === 'bar-stacked' || type === 'bar-100'
}

/** Histogram bin-count bounds — also the clamp used by makeChart. */
export const HISTOGRAM_BINS_MIN = 2
export const HISTOGRAM_BINS_MAX = 50
export const HISTOGRAM_BINS_DEFAULT = 10

/**
 * histogramBins — bin a flat list of numbers into `bins` equal-width buckets.
 *
 * Pure + bounded: `bins` is clamped to [2,50] (the makeChart clamp already caps
 * the descriptor, this is belt-and-braces for direct callers), non-finite values
 * are dropped, and a degenerate range (all values equal) collapses to one bucket
 * so the renderer never divides by zero. The last bucket is inclusive of the max
 * (standard histogram convention), every other bucket is [x0, x1).
 *
 * Returns { bins: [{ x0, x1, count, label }], max, total }.
 */
export function histogramBins(values: unknown[] | null | undefined, bins: unknown = HISTOGRAM_BINS_DEFAULT): HistogramResult {
  const nums: number[] = []
  for (const v of values || []) {
    // A BLANK is not a zero. `Number(null)`/`Number('')` are both 0, so filtering
    // on isFinite alone would pack a bucket at 0 with every empty row in the
    // range and misrepresent the distribution.
    if (v === '' || v === null || v === undefined) continue
    const n = Number(v)
    if (isFinite(n)) nums.push(n)
  }
  if (!nums.length) return { bins: [], max: 0, total: 0 }
  const k = Math.min(HISTOGRAM_BINS_MAX, Math.max(HISTOGRAM_BINS_MIN, Math.floor(Number(bins)) || HISTOGRAM_BINS_DEFAULT))
  let lo = Math.min(...nums)
  let hi = Math.max(...nums)
  if (lo === hi) { lo -= 0.5; hi += 0.5 }   // degenerate range → one centred bucket
  const width = (hi - lo) / k
  const out: HistogramBin[] = []
  for (let i = 0; i < k; i++) {
    const x0 = lo + i * width
    const x1 = i === k - 1 ? hi : lo + (i + 1) * width
    out.push({ x0, x1, count: 0, label: `${binNum(x0)}–${binNum(x1)}` })
  }
  for (const n of nums) {
    let i = Math.floor((n - lo) / width)
    if (i < 0) i = 0
    if (i >= k) i = k - 1                    // max value lands in the last bucket
    out[i].count++
  }
  let max = 0
  for (const b of out) if (b.count > max) max = b.count
  return { bins: out, max, total: nums.length }
}

function binNum(v: number): string {
  const r = Math.round(v * 100) / 100
  return String(r)
}

/**
 * histogramValues — the values a histogram bins: the FIRST series' genuinely
 * numeric cells (see extractChartData's `numeric`), never the 0-filled plotting
 * shape. One helper so the renderer, the a11y summary and the xlsx writer can
 * never disagree about what the histogram is counting.
 */
export function histogramValues(extracted: ExtractedChartData | null | undefined): number[] {
  const s = extracted?.series?.[0]
  if (!s) return []
  return Array.isArray(s.numeric) ? s.numeric : (s.values || [])
}

// A palette of fixed, non-user colours for series/slices. Never derived from
// cell data, so it cannot be an injection vector.
export const CHART_PALETTE = [
  '#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6',
  '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16',
]

let _seq = 0
/** Stable-ish unique id; monotonic counter guards against Math.random collisions in a burst. */
export function newChartId(): string {
  _seq = (_seq + 1) % 1e6
  return 'cht_' + Date.now().toString(36) + '_' + _seq.toString(36) + Math.random().toString(36).slice(2, 6)
}

/**
 * escapeChartText — normalise an untrusted cell value to a safe display string.
 *
 * The SVG renderer already escapes via React text children, so this is NOT what
 * stops XSS on screen. Its job is (a) coerce non-strings, (b) strip control
 * chars, and (c) neutralise a leading formula trigger (`= + - @`) the way a
 * spreadsheet import guard does, so a value like `=HYPERLINK(...)` can never be
 * interpreted as a formula if a chart label is later pasted/exported into a
 * context that re-parses it. Returns a plain string, no markup.
 */
export function escapeChartText(v: unknown, max = 200): string {
  if (v === null || v === undefined) return ''
  let s = typeof v === 'string' ? v : String(v)
  // Collapse tab/newline to a single space, then drop the remaining C0/DEL
  // control chars so a hostile cell can't smuggle terminal/format sequences.
  s = s.replace(/[\t\n\r]+/g, ' ')
       // eslint-disable-next-line no-control-regex -- deliberately stripping C0/DEL control chars
       .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
  // Neutralise a leading formula/command trigger (CSV-injection style guard).
  if (/^[=+\-@]/.test(s)) s = "'" + s
  if (s.length > max) s = s.slice(0, max - 1) + '…'
  return s
}

/**
 * makeChart — construct a well-formed chart descriptor with defaults, clamping
 * every field. Unknown chart types fall back to 'column'. Positions/sizes are
 * numbers with sane bounds so a corrupt/hostile descriptor can't produce an
 * absurd SVG. Always returns a fresh plain object (safe to hand to the CRDT).
 */
export function makeChart(partial: ChartInput = {}): Chart {
  const type = typeof partial.type === 'string' && CHART_TYPE_SET.has(partial.type) ? partial.type : 'column'
  const num = (v: unknown, d: number, lo: number, hi: number, int = false): number => {
    const n = Number(v)
    if (!isFinite(n)) return d
    const clamped = Math.min(hi, Math.max(lo, n))
    return int ? Math.round(clamped) : clamped
  }
  return {
    id:    typeof partial.id === 'string' && partial.id ? partial.id : newChartId(),
    type,
    range: typeof partial.range === 'string' ? partial.range.trim().toUpperCase() : '',
    title: typeof partial.title === 'string' ? partial.title.slice(0, 200) : '',
    options: {
      xAxisLabel: typeof partial.options?.xAxisLabel === 'string' ? partial.options.xAxisLabel.slice(0, 120) : '',
      yAxisLabel: typeof partial.options?.yAxisLabel === 'string' ? partial.options.yAxisLabel.slice(0, 120) : '',
      // y2AxisLabel: the SECONDARY (right-hand) value axis of a combo chart.
      y2AxisLabel: typeof partial.options?.y2AxisLabel === 'string' ? partial.options.y2AxisLabel.slice(0, 120) : '',
      legend:     partial.options?.legend === false ? false : true,
      // headerRow/headerCol: whether the first row/col of the range holds labels.
      headerRow:  partial.options?.headerRow !== false,
      headerCol:  partial.options?.headerCol !== false,
      // WAVE-64. secondaryAxis (combo): plot the LINE series against their own
      // right-hand scale, so a small-magnitude series (e.g. a % margin) is still
      // readable next to large columns. Explicit opt-in: anything that is not
      // literally `true` is false, so a hostile `'yes'` / {} can never enable it.
      secondaryAxis: partial.options?.secondaryAxis === true,
      // bins (histogram): integer bucket count, clamped to [2,50]. A non-finite /
      // hostile value falls back to the default — never NaN (which would drive a
      // NaN-width bar and an infinite bucket loop).
      bins: num(partial.options?.bins, HISTOGRAM_BINS_DEFAULT, HISTOGRAM_BINS_MIN, HISTOGRAM_BINS_MAX, true),
    },
    x: num(partial.x, 40,  0, 100000),
    y: num(partial.y, 40,  0, 100000),
    w: num(partial.w, 480, 160, 4000),
    h: num(partial.h, 300, 120, 4000),
  }
}

/** Read the charts array off the first sheet (always an array). */
export function getCharts(data: ChartSheet[] | null | undefined): Chart[] {
  const arr = data?.[0]?.charts
  return Array.isArray(arr) ? arr : []
}

/**
 * chartsBySheetId — index the authoritative charts of a workbook by sheet id
 * (falling back to positional index when a sheet has no id). Charts are an
 * app-owned overlay field FortuneSheet knows nothing about, so when its
 * `onChange` re-emits normalised sheet objects it DROPS `sheet.charts`
 * (WAVE-61 data-loss). We snapshot the charts here, keyed stably, so they can be
 * re-attached to the normalised sheets in `mergeCharts`.
 */
export function chartsBySheetId(data: ChartSheet[] | null | undefined): Map<string, Chart[]> {
  const map = new Map<string, Chart[]>()
  ;(data || []).forEach((sheet, idx) => {
    if (Array.isArray(sheet?.charts) && sheet.charts.length) {
      map.set(sheet?.id ?? `#${idx}`, sheet.charts)
    }
  })
  return map
}

/**
 * mergeCharts — re-attach an authoritative charts map (see chartsBySheetId)
 * onto a fresh (normalised) workbook array, matching by sheet id then position.
 *
 * This is the WAVE-61 fix core: FortuneSheet's `onChange` payload never carries
 * `sheet.charts`, so `setData(payload)` would clobber locally-inserted charts on
 * grid init and on every cell edit. Merging the app's own charts back makes them
 * a first-class, locally-authoritative, persisted part of the sheet model.
 *
 * The charts are the LOCAL USER'S OWN (trusted) — this path deliberately does
 * NOT re-run them through makeChart on every keystroke (that would be pure
 * overhead). Well-formedness is enforced where a chart ENTERS the model
 * (ChartWizard→insertChart/updateChart, and the WAVE-55 chart_op ingress which
 * still funnels every untrusted peer descriptor through makeChart). To keep a
 * corrupt local state from crashing render, `clampCharts` below re-clamps if a
 * chart is ever missing finite geometry.
 */
export function mergeCharts(nextData: ChartSheet[] | null | undefined, chartsMap: Map<string, Chart[]> | null | undefined): ChartSheet[] | null | undefined {
  if (!chartsMap || chartsMap.size === 0) return nextData
  return (nextData || []).map((sheet, idx) => {
    const key = sheet?.id ?? `#${idx}`
    const preserved = chartsMap.get(key) ?? (idx === 0 ? chartsMap.values().next().value : undefined)
    // If the normalised sheet already carries charts (rare), keep them; else
    // re-attach the authoritative ones we snapshotted before normalisation.
    if (Array.isArray(sheet?.charts) && sheet.charts.length) return sheet
    if (preserved && preserved.length) return { ...sheet, charts: preserved }
    return sheet
  })
}

/**
 * clampCharts — defensively re-clamp the charts on the first sheet through
 * makeChart so a corrupt/legacy local descriptor (e.g. non-finite geometry from
 * a stale draft) can never reach the SVG renderer with NaN layout. Idempotent on
 * already-well-formed charts. Used when loading content into the editor.
 */
export function clampCharts(data: ChartSheet[] | null | undefined): ChartSheet[] | null | undefined {
  const charts = getCharts(data)
  if (!charts.length) return data
  return setCharts(data, charts.map((c) => makeChart(c)))
}

/** Immutably replace the charts array on the first sheet. */
export function setCharts(data: ChartSheet[] | null | undefined, charts: unknown): ChartSheet[] {
  return (data || []).map((sheet, idx) =>
    idx === 0 ? { ...sheet, charts: Array.isArray(charts) ? charts : [] } : sheet
  )
}

/** Insert a chart (immutably). Returns new workbook data. */
export function insertChart(data: ChartSheet[] | null | undefined, chart: ChartInput): ChartSheet[] {
  return setCharts(data, [...getCharts(data), makeChart(chart)])
}

/** Update a chart by id with a partial patch (immutably). */
export function updateChart(data: ChartSheet[] | null | undefined, id: string, patch: ChartInput): ChartSheet[] {
  const next = getCharts(data).map((c) =>
    c.id === id ? makeChart({ ...c, ...patch, options: { ...c.options, ...(patch.options || {}) } }) : c
  )
  return setCharts(data, next)
}

/** Delete a chart by id (immutably). */
export function deleteChart(data: ChartSheet[] | null | undefined, id: string): ChartSheet[] {
  return setCharts(data, getCharts(data).filter((c) => c.id !== id))
}

// ── Cell reads ──────────────────────────────────────────────────────────────

/**
 * Build a fast {r,c} → cell lookup from FortuneSheet celldata. Values are the
 * raw cell records; readers below normalise to display string / number.
 */
function celldataIndex(sheet: ChartSheet | null | undefined): Map<string, ChartCellEntry> {
  const idx = new Map<string, ChartCellEntry>()
  for (const cell of sheet?.celldata || []) {
    idx.set(cell.r + ',' + cell.c, cell)
  }
  return idx
}

/** Display string of a FortuneSheet cell record (mirrors export's v.v ?? v.m). */
function cellDisplay(cell: ChartCellEntry | undefined): string | number | boolean {
  const v = cell?.v
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') return v.v !== undefined && v.v !== null ? v.v : (v.m ?? '')
  return v
}

/** Numeric value of a cell (NaN when not a number). Used for plotting. */
function cellNumber(cell: ChartCellEntry | undefined): number {
  const d = cellDisplay(cell)
  if (typeof d === 'number') return d
  if (typeof d === 'string' && d.trim() !== '') {
    const n = Number(d.replace(/[$,%\s]/g, ''))
    if (isFinite(n)) return n
  }
  return NaN
}

/**
 * extractChartData — turn a chart descriptor + the current sheet cells into a
 * plottable, PLAIN-DATA structure. This is the reactive core: call it whenever
 * cells change to get fresh numbers. All label strings are run through
 * escapeChartText so downstream never sees a raw formula/control string.
 *
 * Returns:
 *   {
 *     categories: string[],                 // x-axis / slice labels (escaped)
 *     series: [{ name: string, values: number[], color: string }],
 *     empty: boolean,                       // true when nothing numeric to plot
 *   }
 *
 * Orientation: columns are series, rows are categories (Sheets default for a
 * tall range). headerRow ⇒ first row = series names; headerCol ⇒ first col =
 * category labels.
 */
export function extractChartData(chart: Chart | ChartInput, sheet: ChartSheet | null | undefined): ExtractedChartData {
  const parsed = parseRange(String(chart?.range || ''))?.[0] as ParsedRangeRect
  const [r0, r1] = parsed.row
  const [c0, c1] = parsed.column
  // Guard against a pathological range blowing up memory.
  const rows = Math.min(r1 - r0 + 1, 1000)
  const cols = Math.min(c1 - c0 + 1, 100)
  const idx = celldataIndex(sheet)

  const opt = chart.options || {}
  const hasHeaderRow = opt.headerRow !== false && rows > 1
  const hasHeaderCol = opt.headerCol !== false && cols > 1

  const dataR0 = hasHeaderRow ? r0 + 1 : r0
  const dataC0 = hasHeaderCol ? c0 + 1 : c0

  const categories: string[] = []
  for (let r = dataR0; r < r0 + rows; r++) {
    if (hasHeaderCol) {
      categories.push(escapeChartText(cellDisplay(idx.get(r + ',' + c0))))
    } else {
      categories.push(String(r - dataR0 + 1))
    }
  }

  const series: ChartSeries[] = []
  let si = 0
  for (let c = dataC0; c < c0 + cols; c++) {
    const name = hasHeaderRow
      ? escapeChartText(cellDisplay(idx.get(r0 + ',' + c))) || `Series ${si + 1}`
      : `Series ${si + 1}`
    const values: number[] = []
    // `numeric` = only the cells that REALLY held a number. `values` keeps the
    // 0-filled shape a cartesian plot needs (one point per category), but a
    // distribution (histogram) must not treat a blank or text row as a zero — that
    // would invent a spike at 0 for every empty row inside the range.
    const numeric: number[] = []
    for (let r = dataR0; r < r0 + rows; r++) {
      const n = cellNumber(idx.get(r + ',' + c))
      const ok = isFinite(n)
      values.push(ok ? n : 0)
      if (ok) numeric.push(n)
    }
    series.push({ name, values, numeric, color: CHART_PALETTE[si % CHART_PALETTE.length] })
    si++
  }

  const empty = series.length === 0 ||
    series.every((s) => s.values.every((v) => v === 0)) ||
    categories.length === 0

  return { categories, series, empty }
}

/**
 * chartValuesSignature — a cheap string fingerprint of exactly the cells a chart
 * depends on, plus its shape-affecting fields. Used as a memo/dep key so a chart
 * only recomputes when ITS source range values (or its own config) change — not
 * on every keystroke elsewhere in the grid.
 */
export function chartValuesSignature(chart: Chart | ChartInput, sheet: ChartSheet | null | undefined): string {
  const parsed = parseRange(String(chart?.range || ''))?.[0] as ParsedRangeRect
  const [r0, r1] = parsed.row
  const [c0, c1] = parsed.column
  const rows = Math.min(r1 - r0 + 1, 1000)
  const cols = Math.min(c1 - c0 + 1, 100)
  const idx = celldataIndex(sheet)
  const parts: string[] = []
  for (let r = r0; r < r0 + rows; r++) {
    for (let c = c0; c < c0 + cols; c++) {
      const d = cellDisplay(idx.get(r + ',' + c))
      if (d !== '') parts.push(r + ':' + c + '=' + d)
    }
  }
  // Include the config that changes the plotted shape/labels. WAVE-64: bins and
  // secondaryAxis are shape-affecting too — omitting them would freeze a chart's
  // memoised extraction when only those change.
  return chart.type + '|' + chart.range + '|' + chart.title + '|' +
    (chart.options?.headerRow) + '|' + (chart.options?.headerCol) + '|' +
    (chart.options?.secondaryAxis) + '|' + (chart.options?.bins) + '|' +
    parts.join(',')
}

/**
 * chartAccessibleSummary — a plain-text, screen-reader summary of a chart. Pure
 * text (escaped), used for the SVG <title>/<desc> and aria-label.
 */
export function chartAccessibleSummary(chart: Chart, extracted: ExtractedChartData | null | undefined): string {
  const kind = CHART_TYPES.find((t) => t.value === chart.type)?.label || chart.type
  const title = escapeChartText(chart.title) || 'Untitled chart'
  if (!extracted || extracted.empty) {
    return `${kind} chart: ${title}. No data to plot.`
  }
  // A histogram has no categories of its own — it summarises ONE numeric series
  // as a frequency distribution, so describe it that way for a screen reader.
  if (chart.type === 'histogram') {
    const h = histogramBins(histogramValues(extracted), chart.options?.bins)
    return `${kind} chart: ${title}. ${h.total} values distributed across ${h.bins.length} bins, ` +
      `tallest bin ${h.max}.`
  }
  const seriesNames = extracted.series.map((s) => s.name).join(', ')
  const mode = stackModeOf(chart.type)
  const stackNote = mode === 'stacked' ? ' Series are stacked.'
    : mode === 'percent' ? ' Series are stacked to 100% of each category.'
    : chart.type === 'combo' && chart.options?.secondaryAxis ? ' Line series use a secondary axis.'
    : ''
  return `${kind} chart: ${title}. ${extracted.series.length} series ` +
    `(${seriesNames}) across ${extracted.categories.length} categories.${stackNote}`
}
