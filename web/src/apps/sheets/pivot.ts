/**
 * src/apps/sheets/pivot.ts  (WAVE-63 — reactive pivot tables)
 *
 * Pure pivot model + aggregation, mirroring the WAVE-54 chart model discipline.
 *
 * A pivot is PLAIN STRUCTURED DATA (a descriptor), NOT a static snapshot. It is
 * stored on the first sheet as `sheet.pivots` (an array). Each descriptor names
 * a SOURCE RANGE and the row/column/value/aggregation config. The pivot result
 * is RE-AGGREGATED from the current source cells every time those cells change
 * (reactive, like charts), and re-rendered — so a pivot lives instead of going
 * stale.
 *
 *   {
 *     id:        string,
 *     range:     'A1:D100',           // A1 source range (untrusted text)
 *     title:     string,              // untrusted
 *     rowField:  string,              // header name to group rows by
 *     colField:  string,              // header name to group cols by ('' = none)
 *     rowGroup:  'none'|'day'|'month'|'quarter'|'year',   // date bucketing (WAVE-64)
 *     colGroup:  'none'|'day'|'month'|'quarter'|'year',
 *     values:    [{ field, agg, display }],               // MULTIPLE value fields (WAVE-64)
 *     valueField:string,              // legacy mirror of values[0].field
 *     agg:       PIVOT_AGGS[number],  // legacy mirror of values[0].agg
 *   }
 *
 * agg     ∈ SUM AVG COUNT COUNTA MAX MIN MEDIAN STDDEV PRODUCT COUNTUNIQUE
 * display ∈ raw | pct_total | pct_row | pct_col   (percentages on a 0–100 scale)
 *
 * SECURITY (WAVE-55 posture, reused): the descriptor rides the CRDT fabric as a
 * `pivot_op`, so it arrives from UNTRUSTED peers. `makePivot` is the fail-closed
 * clamp run at ingress: type/agg are allow-listed, strings are coerced + length
 * -capped, range is normalised. A pivot with no usable string id is dropped by
 * the caller. Aggregation is bounded (source rows/cols capped) so a hostile
 * config can't drive an unbounded loop (DoS). Every header/label that reaches
 * the DOM is React-escaped text — nothing here builds HTML or evals.
 */

export type PivotAgg = 'SUM' | 'AVG' | 'COUNT' | 'COUNTA' | 'MAX' | 'MIN' | 'MEDIAN' | 'STDDEV' | 'PRODUCT' | 'COUNTUNIQUE'
export type PivotDisplay = 'raw' | 'pct_total' | 'pct_row' | 'pct_col'
export type PivotGrouping = 'none' | 'day' | 'month' | 'quarter' | 'year'

export interface PivotValueSpec {
  field: string
  agg: PivotAgg
  display: PivotDisplay
}

export interface Pivot {
  id: string
  range: string
  title: string
  rowField: string
  colField: string
  valueField: string
  agg: PivotAgg
  values: PivotValueSpec[]
  rowGroup: PivotGrouping
  colGroup: PivotGrouping
  x: number
  y: number
}

/** Loose, pre-validation input to `makePivot`. */
export interface PivotInput {
  id?: unknown
  range?: unknown
  title?: unknown
  rowField?: unknown
  colField?: unknown
  valueField?: unknown
  agg?: unknown
  values?: unknown
  rowGroup?: unknown
  colGroup?: unknown
  x?: unknown
  y?: unknown
}

export interface PivotCellValue {
  v?: string | number | boolean
  m?: string | number
  [key: string]: unknown
}
export interface PivotCellEntry {
  r: number
  c: number
  v?: PivotCellValue | string | number | boolean | null
}
export interface PivotSheet {
  id?: string
  celldata?: PivotCellEntry[]
  pivots?: Pivot[]
  [key: string]: unknown
}

export interface PivotModel {
  header: string[]
  displays: (PivotDisplay | null)[]
  table: (string | number)[][]
}

export interface PivotSheetResult {
  name: string
  celldata: {
    r: number
    c: number
    v: { v: string | number; m: string; ct: { fa: string; t: string }; bl?: number }
  }[]
  config: Record<string, never>
}

interface Bounds { r0: number; r1: number; c0: number; c1: number }

export const PIVOT_AGGS: PivotAgg[] = [
  'SUM', 'AVG', 'COUNT', 'COUNTA', 'MAX', 'MIN',
  // WAVE-64 additions.
  'MEDIAN', 'STDDEV', 'PRODUCT', 'COUNTUNIQUE',
]
const PIVOT_AGG_SET: Set<string> = new Set(PIVOT_AGGS)

/**
 * Display modes (WAVE-64) — how an aggregated cell is PRESENTED. 'raw' is the
 * aggregate itself; the pct_* modes divide it by the same aggregate taken over a
 * wider set (the whole table / the cell's row / the cell's column) and render it
 * on a 0–100 scale. Percentages are computed by RE-AGGREGATING the raw source
 * rows of the denominator set — never by summing sub-aggregates, which would be
 * nonsense for AVG/MAX/MEDIAN.
 */
export const PIVOT_DISPLAYS: PivotDisplay[] = ['raw', 'pct_total', 'pct_row', 'pct_col']
const PIVOT_DISPLAY_SET: Set<string> = new Set(PIVOT_DISPLAYS)
export const PIVOT_DISPLAY_LABEL: Record<PivotDisplay, string> = {
  raw:       'Value',
  pct_total: '% of total',
  pct_row:   '% of row',
  pct_col:   '% of column',
}

/** Date-grouping buckets (WAVE-64) for a row/column field holding dates. */
export const PIVOT_GROUPINGS: PivotGrouping[] = ['none', 'day', 'month', 'quarter', 'year']
const PIVOT_GROUPING_SET: Set<string> = new Set(PIVOT_GROUPINGS)
export const PIVOT_GROUPING_LABEL: Record<PivotGrouping, string> = {
  none: 'No grouping', day: 'By day', month: 'By month', quarter: 'By quarter', year: 'By year',
}

// Only-numeric view of a group's values (blank/text rows are ignored, matching
// spreadsheet SUM/AVERAGE/MAX/MIN semantics — a blank cell is NOT counted as 0).
function numeric(vals: unknown[]): number[] {
  const out: number[] = []
  for (const v of vals) {
    if (v === '' || v === null || v === undefined) continue
    const n = Number(v)
    if (!Number.isNaN(n)) out.push(n)
  }
  return out
}
const AGG_FN: Record<string, (vals: unknown[]) => number> = {
  SUM:    (vals) => numeric(vals).reduce((a, b) => a + b, 0),
  // AVG divides by the count of NUMERIC values, not total group rows — a blank
  // or text row must not drag the average toward zero.
  AVG:    (vals) => { const n = numeric(vals); return n.length ? n.reduce((a, b) => a + b, 0) / n.length : 0 },
  COUNT:  (vals) => numeric(vals).length,
  COUNTA: (vals) => vals.filter((v) => v !== '' && v !== null && v !== undefined).length,
  MAX:    (vals) => { const n = numeric(vals); return n.length ? Math.max(...n) : 0 },
  MIN:    (vals) => { const n = numeric(vals); return n.length ? Math.min(...n) : 0 },
  // MEDIAN — middle of the sorted NUMERIC values (mean of the middle two when
  // the count is even), matching spreadsheet MEDIAN.
  MEDIAN: (vals) => {
    const n = numeric(vals).sort((a, b) => a - b)
    if (!n.length) return 0
    const mid = n.length >> 1
    return n.length % 2 ? n[mid] : (n[mid - 1] + n[mid]) / 2
  },
  // STDDEV — SAMPLE standard deviation (n-1 denominator), matching spreadsheet
  // STDEV. A single sample has no spread to estimate → 0 (not NaN/Infinity).
  STDDEV: (vals) => {
    const n = numeric(vals)
    if (n.length < 2) return 0
    const mean = n.reduce((a, b) => a + b, 0) / n.length
    const ss = n.reduce((a, b) => a + (b - mean) * (b - mean), 0)
    return Math.sqrt(ss / (n.length - 1))
  },
  // PRODUCT — product of the numeric values; an empty group is 0 (not 1), so an
  // empty cell never claims a neutral multiplicative identity it hasn't earned.
  PRODUCT: (vals) => { const n = numeric(vals); return n.length ? n.reduce((a, b) => a * b, 1) : 0 },
  // COUNTUNIQUE — distinct non-blank values (text or number), compared by their
  // string form so 1 and '1' are the same label, as in a spreadsheet.
  COUNTUNIQUE: (vals) => {
    const seen = new Set<string>()
    for (const v of vals) {
      if (v === '' || v === null || v === undefined) continue
      // A real cell value is string/number/boolean; treat anything else as
      // its own single bucket rather than the misleading "[object Object]"
      // a blind String() would collapse every such value into.
      seen.add(typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v))
    }
    return seen.size
  },
}

// Bounds so a hostile/corrupt config can never drive an unbounded aggregation.
const MAX_SOURCE_ROWS = 50000
const MAX_SOURCE_COLS = 200
const MAX_GROUPS = 2000
// A pivot may aggregate several value fields at once; cap the list so a hostile
// descriptor can't multiply the group work by an unbounded factor.
const MAX_VALUES = 8

let _seq = 0
export function newPivotId(): string {
  _seq = (_seq + 1) % 1e6
  return 'pvt_' + Date.now().toString(36) + '_' + _seq.toString(36) + Math.random().toString(36).slice(2, 6)
}

/** Coerce an untrusted cell/label value to a safe, length-capped string. */
export function pivotText(v: unknown, max = 200): string {
  if (v === null || v === undefined) return ''
  // Real cell values are string/number/boolean; anything else has no
  // meaningful text form — empty rather than the literal "[object Object]".
  let s = typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : ''
  // eslint-disable-next-line no-control-regex -- deliberately stripping C0/DEL control chars
  s = s.replace(/[\t\n\r]+/g, ' ').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
  if (/^[=+\-@]/.test(s)) s = "'" + s
  if (s.length > max) s = s.slice(0, max - 1) + '…'
  return s
}

/**
 * makePivot — construct a well-formed pivot descriptor with defaults, clamping
 * every field. Unknown aggregation → 'SUM'. Always a fresh plain object (CRDT-
 * safe). This is the ingress clamp: run it on any peer-supplied descriptor.
 */
export function makePivot(partial: PivotInput = {}): Pivot {
  const agg = (typeof partial.agg === 'string' && PIVOT_AGG_SET.has(partial.agg) ? partial.agg : 'SUM') as PivotAgg
  const s = (v: unknown, max = 120): string => (typeof v === 'string' ? v.slice(0, max) : '')
  // Card position over the grid — finite + bounded (same clamp discipline as
  // makeChart geometry), so a corrupt/hostile descriptor can't drive NaN layout.
  const num = (v: unknown, d: number, lo: number, hi: number): number => { const n = Number(v); return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d }
  const grouping = (v: unknown): PivotGrouping => (typeof v === 'string' && PIVOT_GROUPING_SET.has(v) ? v as PivotGrouping : 'none')

  // WAVE-64 VALUE FIELDS. The descriptor now carries a LIST of value fields
  // (field + aggregation + display mode). The legacy single `valueField`/`agg`
  // pair is still accepted (old saved docs, old peers) and is projected into the
  // list; values[0] is mirrored back onto valueField/agg so an OLD peer reading a
  // NEW descriptor still sees a coherent single-value pivot instead of nothing.
  // Every entry is allow-listed + length-capped: this is the CRDT ingress clamp.
  const valueField = s(partial.valueField)
  let values: PivotValueSpec[] = []
  if (Array.isArray(partial.values)) {
    for (const v of (partial.values as Array<{ field?: unknown; agg?: unknown; display?: unknown }>).slice(0, MAX_VALUES)) {
      const field = s(v?.field)
      if (!field) continue                       // a value with no field is dropped
      values.push({
        field,
        agg:     (typeof v?.agg === 'string' && PIVOT_AGG_SET.has(v.agg) ? v.agg : 'SUM') as PivotAgg,
        display: (typeof v?.display === 'string' && PIVOT_DISPLAY_SET.has(v.display) ? v.display : 'raw') as PivotDisplay,
      })
    }
  }
  if (!values.length && valueField) values = [{ field: valueField, agg, display: 'raw' }]

  return {
    id:         typeof partial.id === 'string' && partial.id ? partial.id : newPivotId(),
    range:      typeof partial.range === 'string' ? partial.range.trim().toUpperCase().slice(0, 40) : '',
    title:      typeof partial.title === 'string' ? partial.title.slice(0, 200) : '',
    rowField:   s(partial.rowField),
    colField:   s(partial.colField),
    // Legacy mirror (see above) — kept in sync with values[0].
    valueField: values.length ? values[0].field : valueField,
    agg:        values.length ? values[0].agg : agg,
    values,
    // Date bucketing for the row / column grouping fields.
    rowGroup:   grouping(partial.rowGroup),
    colGroup:   grouping(partial.colGroup),
    x:          num(partial.x, 40, 0, 100000),
    y:          num(partial.y, 40, 0, 100000),
  }
}

/** Read the pivots array off the first sheet (always an array). */
export function getPivots(data: PivotSheet[] | null | undefined): Pivot[] {
  const arr = data?.[0]?.pivots
  return Array.isArray(arr) ? arr : []
}

/** Immutably replace the pivots array on the first sheet. */
export function setPivots(data: PivotSheet[] | null | undefined, pivots: unknown): PivotSheet[] {
  return (data || []).map((sheet, idx) =>
    idx === 0 ? { ...sheet, pivots: Array.isArray(pivots) ? pivots : [] } : sheet
  )
}

/** Insert a pivot (immutably). */
export function insertPivot(data: PivotSheet[] | null | undefined, pivot: PivotInput): PivotSheet[] {
  return setPivots(data, [...getPivots(data), makePivot(pivot)])
}

/**
 * Update a pivot by id with a partial patch (immutably).
 *
 * A LEGACY single-value patch ({ agg } / { valueField }) must win over the
 * descriptor's existing `values` list — otherwise makePivot would re-mirror the
 * stale list back over the patch and the update would silently do nothing.
 */
export function updatePivot(data: PivotSheet[] | null | undefined, id: string, patch: PivotInput): PivotSheet[] {
  const next = getPivots(data).map((p) => {
    if (p.id !== id) return p
    const merged: PivotInput = { ...p, ...patch }
    if (!patch?.values && (patch?.agg !== undefined || patch?.valueField !== undefined)) {
      delete merged.values
    }
    return makePivot(merged)
  })
  return setPivots(data, next)
}

/** Delete a pivot by id (immutably). */
export function deletePivot(data: PivotSheet[] | null | undefined, id: string): PivotSheet[] {
  return setPivots(data, getPivots(data).filter((p) => p.id !== id))
}

/**
 * clampPivots — defensively re-clamp the pivots on the first sheet through
 * makePivot so a corrupt/legacy local descriptor can never reach aggregation
 * with an unsafe field. Idempotent. Used when loading content.
 */
export function clampPivots(data: PivotSheet[] | null | undefined): PivotSheet[] | null | undefined {
  const pivots = getPivots(data)
  if (!pivots.length) return data
  return setPivots(data, pivots.map((p) => makePivot(p)))
}

/**
 * pivotsBySheetId / mergePivots — mirror the WAVE-61 chart preservation. Pivots
 * are an app-owned overlay field FortuneSheet knows nothing about, so its
 * `onChange` re-emits normalised sheet objects that DROP `sheet.pivots`. We
 * snapshot pivots keyed stably, then re-attach them onto the normalised sheets
 * so a plain cell edit never clobbers a live pivot.
 */
export function pivotsBySheetId(data: PivotSheet[] | null | undefined): Map<string, Pivot[]> {
  const map = new Map<string, Pivot[]>()
  ;(data || []).forEach((sheet, idx) => {
    if (Array.isArray(sheet?.pivots) && sheet.pivots.length) {
      map.set(sheet?.id ?? `#${idx}`, sheet.pivots)
    }
  })
  return map
}

export function mergePivots(nextData: PivotSheet[] | null | undefined, pivotsMap: Map<string, Pivot[]> | null | undefined): PivotSheet[] | null | undefined {
  if (!pivotsMap || pivotsMap.size === 0) return nextData
  return (nextData || []).map((sheet, idx) => {
    const key = sheet?.id ?? `#${idx}`
    const preserved = pivotsMap.get(key) ?? (idx === 0 ? pivotsMap.values().next().value : undefined)
    if (Array.isArray(sheet?.pivots) && sheet.pivots.length) return sheet
    if (preserved && preserved.length) return { ...sheet, pivots: preserved }
    return sheet
  })
}

// ── Cell reads ───────────────────────────────────────────────────────────────

function cellDisplay(cell: PivotCellEntry | undefined): string | number | boolean {
  const v = cell?.v
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') return v.v !== undefined && v.v !== null ? v.v : (v.m ?? '')
  return v
}

// Parse "A1:D100" → {r0,c0,r1,c1} (0-indexed inclusive). Local, tiny, bounded.
function colToIndex(letters: string): number {
  const s = String(letters).toUpperCase()
  let idx = 0
  for (let i = 0; i < s.length; i++) idx = idx * 26 + (s.charCodeAt(i) - 64)
  return idx - 1
}
function parseA1(ref: string): { c: number; r: number } | null {
  const m = String(ref).match(/^([A-Za-z]+)(\d+)$/)
  if (!m) return null
  return { c: colToIndex(m[1]), r: parseInt(m[2], 10) - 1 }
}
function parseRangeBounds(range: string | null | undefined): Bounds | null {
  const parts = String(range || '').trim().toUpperCase().split(':')
  if (parts.length === 1) {
    const a = parseA1(parts[0]); if (!a) return null
    return { r0: a.r, r1: a.r, c0: a.c, c1: a.c }
  }
  const a = parseA1(parts[0]), b = parseA1(parts[1])
  if (!a || !b) return null
  return {
    r0: Math.min(a.r, b.r), r1: Math.max(a.r, b.r),
    c0: Math.min(a.c, b.c), c1: Math.max(a.c, b.c),
  }
}

/**
 * sourceTable — extract the pivot's source range from the sheet as a 2-D array
 * (row-major), header row included. Bounded by MAX_SOURCE_* so a pathological
 * range can't blow up memory/CPU. Returns [] when the range is invalid.
 */
export function sourceTable(pivot: Pivot | PivotInput | null | undefined, sheet: PivotSheet | null | undefined): (string | number | boolean)[][] {
  const b = parseRangeBounds(typeof pivot?.range === 'string' ? pivot.range : '')
  if (!b) return []
  const idx = new Map<string, PivotCellEntry>()
  // Actual populated extent of the sheet — a pivot never needs to materialise
  // cells past the last real cell. This is BOTH the correctness bound (blank
  // trailing rows/cols add nothing) AND the DoS bound: a range like A1:ZZ999999
  // over a 5-row sheet iterates 5 rows, not 10M. We still hard-cap by
  // MAX_SOURCE_* as a belt-and-braces ceiling.
  let usedR = -1, usedC = -1
  for (const cell of sheet?.celldata || []) {
    idx.set(cell.r + ',' + cell.c, cell)
    if (cell.r > usedR) usedR = cell.r
    if (cell.c > usedC) usedC = cell.c
  }
  const rows = Math.min(b.r1, usedR, b.r0 + MAX_SOURCE_ROWS - 1) - b.r0 + 1
  const cols = Math.min(b.c1, usedC, b.c0 + MAX_SOURCE_COLS - 1) - b.c0 + 1
  if (rows <= 0 || cols <= 0) return []
  const table: (string | number | boolean)[][] = []
  for (let r = 0; r < rows; r++) {
    const row: (string | number | boolean)[] = []
    for (let c = 0; c < cols; c++) {
      row.push(cellDisplay(idx.get((b.r0 + r) + ',' + (b.c0 + c))))
    }
    table.push(row)
  }
  return table
}

/**
 * computePivot — aggregate the source table per the descriptor into a plain 2-D
 * result array (header row + data rows + grand-total row). This is the reactive
 * core: call it whenever the source cells change to get a fresh result. All
 * label strings are run through pivotText (safe display). Returns null when the
 * config can't produce a table (missing fields / no data).
 */
// Group-key separator: the ASCII unit-separator, which cannot appear in cell
// display text (control chars are not produced by sourceTable's numeric/text
// reads), so 'row<SEP>col' keys never collide with real category values.
const SEP = ''

/**
 * dateBucket — bucket an untrusted cell value into a day/month/quarter/year key.
 *
 * Accepts a Date, an Excel/Fortune-Sheet DATE SERIAL (days since 1899-12-30 —
 * what a date-formatted cell actually stores in `v.v`), or a parseable date
 * string. Everything is read in UTC so a bucket never shifts with the viewer's
 * timezone. A value that is NOT a date is returned UNCHANGED (as its own group),
 * so a text row can never be silently swallowed into a wrong date bucket.
 */
export function dateBucket(value: unknown, mode: string): string {
  // Reuses pivotText's own untrusted-value coercion (string/number/boolean
  // only — a non-primitive would otherwise collapse into the same
  // "[object Object]" group as every other one, silently merging rows this
  // function's own contract says must stay distinct).
  if (mode === 'none' || !PIVOT_GROUPING_SET.has(mode)) return pivotText(value)
  const d = toDate(value)
  if (!d) return pivotText(value)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth() + 1
  const pad = (n: number) => String(n).padStart(2, '0')
  switch (mode) {
    case 'year':    return String(y)
    case 'quarter': return `${y}-Q${Math.floor((m - 1) / 3) + 1}`
    case 'month':   return `${y}-${pad(m)}`
    case 'day':     return `${y}-${pad(m)}-${pad(d.getUTCDate())}`
    default:        return pivotText(value)
  }
}

// Excel's serial epoch (1899-12-30 UTC) — the base Fortune-Sheet stores too.
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30)
const DAY_MS = 86400000

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value
  if (typeof value === 'number' && isFinite(value)) {
    // Serial dates only: 1 (1900-01-01) … ~2958465 (9999-12-31). A number outside
    // that window is not a date, it is just a number.
    if (value < 1 || value > 2958465) return null
    return new Date(EXCEL_EPOCH_MS + Math.round(value) * DAY_MS)
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const t = Date.parse(value.trim())
    if (!isNaN(t)) return new Date(t)
  }
  return null
}

/** Column label for a value field: "Sales", "Sales (AVG)", "Sales (% of row)"… */
function valueLabel(v: PivotValueSpec, multi: boolean): string {
  const bits: string[] = []
  if (multi) bits.push(v.agg)
  if (v.display !== 'raw') bits.push(PIVOT_DISPLAY_LABEL[v.display])
  const base = pivotText(v.field)
  return bits.length ? `${base} (${bits.join(', ')})` : base
}

interface ResolvedValueSpec extends PivotValueSpec {
  idx: number
  fn: (vals: unknown[]) => number
}

/**
 * computePivotModel — the structured pivot result.
 *
 * Returns { header: string[], displays: (string|null)[], table: any[][] } where
 * `displays[i]` names the display mode of column i ('raw' | 'pct_*' | null for
 * the row-label column) so a renderer can format a percentage as a percentage.
 * `table` is header + data rows + the grand-total row.
 *
 * Multiple value fields expand into multiple columns per column-group; the row
 * TOTAL column is emitted per value field. Percentages divide the cell's
 * aggregate by the SAME aggregate re-taken over the denominator set (whole
 * table / the cell's row / the cell's column) — never by summing sub-aggregates.
 */
export function computePivotModel(pivot: Pivot, sheet: PivotSheet | null | undefined): PivotModel | null {
  const table = sourceTable(pivot, sheet)
  if (!table || table.length < 2) return null
  const headers = table[0].map((h) => String(h ?? ''))
  const rowIdx = headers.indexOf(pivot.rowField)
  const colIdx = pivot.colField ? headers.indexOf(pivot.colField) : -1
  if (rowIdx < 0) return null

  // Resolve the value fields to source column indexes; a value naming a header
  // that does not exist is dropped (fail-closed) rather than aggregating junk.
  const legacy: PivotValueSpec[] = pivot.valueField ? [{ field: pivot.valueField, agg: pivot.agg || 'SUM', display: 'raw' }] : []
  const specs: ResolvedValueSpec[] = []
  for (const v of (Array.isArray(pivot.values) && pivot.values.length ? pivot.values : legacy)) {
    const idx = headers.indexOf(v.field)
    if (idx < 0) continue
    specs.push({ ...v, idx, fn: AGG_FN[v.agg] || AGG_FN.SUM })
  }
  if (!specs.length) return null

  const rowGroup = pivot.rowGroup || 'none'
  const colGroup = pivot.colGroup || 'none'

  const rows = new Set<string>()
  const cols = new Set<string>()
  const groups = new Map<string, (string | number | boolean)[][]>()          // key → the raw SOURCE ROWS in that cell
  for (let i = 1; i < table.length; i++) {
    if (groups.size > MAX_GROUPS) break // bound group explosion
    const row = table[i]
    const rv = dateBucket(row[rowIdx], rowGroup)
    const cv = colIdx >= 0 ? dateBucket(row[colIdx], colGroup) : '__value__'
    rows.add(rv)
    cols.add(cv)
    const key = rv + SEP + cv
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(row)
  }

  const rowArr = [...rows].sort()
  const colArr = [...cols].sort()
  const showCols = colIdx >= 0
  const allCvs = showCols ? colArr : ['__value__']
  const multi = specs.length > 1

  // Raw source rows for a set of (row, column) cells.
  const rowsFor = (rvs: string[], cvs: string[]): (string | number | boolean)[][] => {
    const out: (string | number | boolean)[][] = []
    for (const rv of rvs) for (const cv of cvs) {
      const g = groups.get(rv + SEP + cv)
      if (g) out.push(...g)
    }
    return out
  }
  const aggOf = (srcRows: (string | number | boolean)[][], spec: ResolvedValueSpec): number => spec.fn(srcRows.map((r) => r[spec.idx]))

  // Percent denominators, computed ONCE per spec / row / column — and only when a
  // spec actually asks for a percentage (the common all-'raw' pivot pays nothing).
  const needsPct = specs.some((s) => s.display !== 'raw')
  const grand = new Map<number, number>()   // spec index → agg over every row
  const rowDen = new Map<string, number>()  // `${si}|${rv}`
  const colDen = new Map<string, number>()  // `${si}|${cv}`
  if (needsPct) {
    specs.forEach((spec, si) => {
      grand.set(si, aggOf(rowsFor(rowArr, allCvs), spec))
      for (const rv of rowArr) rowDen.set(si + '|' + rv, aggOf(rowsFor([rv], allCvs), spec))
      for (const cv of allCvs) colDen.set(si + '|' + cv, aggOf(rowsFor(rowArr, [cv]), spec))
    })
  }

  // present — apply the display mode. In a TOTAL cell the natural denominator of
  // the mode does not exist (a row-total has no single column), so it widens to
  // the grand total: the total column under "% of column" is that row's share of
  // everything, which is the only reading that stays additive.
  const present = (value: number, spec: ResolvedValueSpec, si: number, rv: string | null, cv: string | null): number => {
    if (spec.display === 'raw') return round(value)
    const den = spec.display === 'pct_total' ? grand.get(si)
      : spec.display === 'pct_row' ? (rv != null ? rowDen.get(si + '|' + rv) : grand.get(si))
      : (cv != null ? colDen.get(si + '|' + cv) : grand.get(si))
    if (!den) return 0                            // 0 / undefined denominator → 0%, never NaN/∞
    return round((value / den) * 100)
  }

  // ── Header + per-column display map ──────────────────────────────────────
  const header: string[] = [pivotText(pivot.rowField)]
  const displays: (PivotDisplay | null)[] = [null]
  if (showCols) {
    for (const cv of colArr) {
      for (const spec of specs) {
        header.push(multi ? `${pivotText(cv)} · ${valueLabel(spec, true)}` : pivotText(cv))
        displays.push(spec.display)
      }
    }
  } else {
    for (const spec of specs) {
      header.push(valueLabel(spec, multi))
      displays.push(spec.display)
    }
  }
  for (const spec of specs) {
    header.push(multi ? `Total · ${valueLabel(spec, true)}` : 'Total')
    displays.push(spec.display)
  }

  // ── Data rows ─────────────────────────────────────────────────────────────
  const out: (string | number)[][] = [header]
  for (const rv of rowArr) {
    const dataRow: (string | number)[] = [pivotText(rv)]
    for (const cv of allCvs) {
      specs.forEach((spec, si) => {
        const cellRows = groups.get(rv + SEP + cv) || []
        dataRow.push(present(aggOf(cellRows, spec), spec, si, rv, cv))
      })
    }
    // Row total: RE-AGGREGATE the row's raw values (not a sum of sub-aggregates),
    // so an AVG/MAX/MEDIAN total is the real thing and not a sum-of-averages.
    specs.forEach((spec, si) => {
      const raw = aggOf(rowsFor([rv], allCvs), spec)
      // A row's total under "% of row" is by definition the whole row = 100%.
      dataRow.push(spec.display === 'pct_row' ? round(raw ? 100 : 0)
        : spec.display === 'raw' ? round(raw)
        : present(raw, spec, si, rv, null))
    })
    out.push(dataRow)
  }

  // ── Grand-total row ───────────────────────────────────────────────────────
  const totRow: (string | number)[] = ['Total']
  for (const cv of allCvs) {
    specs.forEach((spec, si) => {
      const raw = aggOf(rowsFor(rowArr, [cv]), spec)
      totRow.push(spec.display === 'pct_col' ? round(raw ? 100 : 0)
        : spec.display === 'raw' ? round(raw)
        : present(raw, spec, si, null, cv))
    })
  }
  specs.forEach((spec, _si) => {
    const raw = aggOf(rowsFor(rowArr, allCvs), spec)
    totRow.push(spec.display === 'raw' ? round(raw) : round(raw ? 100 : 0))
  })
  out.push(totRow)

  return { header, displays, table: out }
}

/**
 * computePivot — the plain 2-D result array (header + data rows + grand total).
 * Thin wrapper over computePivotModel, kept as the stable shape used by the
 * renderers, the static-sheet materialiser and the CRDT-era callers.
 */
export function computePivot(pivot: Pivot, sheet: PivotSheet | null | undefined): (string | number)[][] | null {
  const model = computePivotModel(pivot, sheet)
  return model ? model.table : null
}

/**
 * pivotPercentColumns — the set of column indexes whose values are percentages,
 * so a renderer can suffix '%' instead of showing a bare 33.33.
 */
export function pivotPercentColumns(model: PivotModel | null | undefined): Set<number> {
  const set = new Set<number>()
  ;(model?.displays || []).forEach((d, i) => { if (d && d !== 'raw') set.add(i) })
  return set
}

function round(v: unknown): number {
  const n = Number(v)
  if (!isFinite(n)) return 0
  return Math.round(n * 1e6) / 1e6
}

/**
 * pivotToSheet — materialise a pivot RESULT as a real FortuneSheet sheet object
 * (celldata), so it can be exported to XLSX, referenced by formulas, and charted
 * — the capability the old static-snapshot pivot had. This is the "insert as
 * static values" path: it snapshots the current aggregation into cells (it does
 * NOT stay reactive — that's what the live descriptor is for). Header row/col are
 * bolded. Values are already safe (pivotText for labels; numbers for aggregates).
 */
export function pivotToSheet(pivot: Pivot, sheet: PivotSheet | null | undefined, name: string | null | undefined): PivotSheetResult | null {
  const model = computePivotModel(pivot, sheet)
  if (!model) return null
  const result = model.table
  // A percentage column must EXPORT as a percentage: the values are on a 0–100
  // scale, so the format code appends a literal % rather than multiplying by 100
  // again (which `0.00%` would do, showing 3333% for a third).
  const pctCols = pivotPercentColumns(model)
  const celldata: PivotSheetResult['celldata'] = []
  for (let r = 0; r < result.length; r++) {
    for (let c = 0; c < result[r].length; c++) {
      const val = result[r][c]
      if (val === '' || val === null || val === undefined) continue
      const isNum = typeof val === 'number'
      const fa = isNum && r > 0 && pctCols.has(c) ? '0.00"%"' : 'General'
      celldata.push({
        r, c,
        v: {
          v: val, m: String(val),
          ct: { fa, t: isNum ? 'n' : 's' },
          ...(r === 0 || c === 0 ? { bl: 1 } : {}),
        },
      })
    }
  }
  const base = (name || `Pivot_${pivot.rowField}_${pivot.valueField}` || 'Pivot').slice(0, 31)
  return { name: base, celldata, config: {} }
}

/** headers available in a pivot source (for the config UI dropdowns). */
export function pivotHeaders(pivot: Pivot | PivotInput | null | undefined, sheet: PivotSheet | null | undefined): string[] {
  const table = sourceTable(pivot, sheet)
  if (!table.length) return []
  return table[0].map((h) => String(h ?? '')).filter(Boolean)
}

/**
 * pivotValuesSignature — a cheap fingerprint of exactly the source cells a pivot
 * depends on, plus its config. Used as a memo key so a pivot only recomputes
 * when ITS source values or config change — not on every unrelated keystroke.
 */
export function pivotValuesSignature(pivot: Pivot, sheet: PivotSheet | null | undefined): string {
  const b = parseRangeBounds(pivot?.range)
  if (!b) return pivot.id + '|invalid'
  // Fingerprint only the cells INSIDE the range that are actually populated —
  // iterate the celldata directly (bounded by the number of real cells), not
  // the raw range area, so a huge range doesn't produce a huge signature loop.
  const parts: string[] = []
  for (const cell of sheet?.celldata || []) {
    if (cell.r < b.r0 || cell.r > b.r1 || cell.c < b.c0 || cell.c > b.c1) continue
    const d = cellDisplay(cell)
    if (d !== '') parts.push(cell.r + ':' + cell.c + '=' + d)
  }
  parts.sort()
  return [
    pivot.range, pivot.rowField, pivot.colField, pivot.valueField, pivot.agg,
    // WAVE-64 config that changes the RESULT must be in the memo key too, or a
    // pivot would keep showing a stale table after its values / grouping change.
    (pivot.values || []).map((v) => `${v.field}:${v.agg}:${v.display}`).join('+'),
    pivot.rowGroup, pivot.colGroup,
    parts.join(','),
  ].join('|')
}
