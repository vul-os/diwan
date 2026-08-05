/**
 * src/apps/sheets/xlsxChartsRead.ts
 *
 * READ real OOXML charts (and DETECT pivot tables) in an imported .xlsx.
 *
 * THE DATA LOSS THIS CLOSES. xlsxCharts.js taught the EXPORT path to write
 * genuine chart parts, but import never learned to read them: SheetJS (community
 * `xlsx`) exposes cells only — it does not surface `xl/charts/chartN.xml` at all.
 * So opening a chart-bearing .xlsx that Excel/Sheets/openpyxl wrote gave a
 * workbook with the cells and NO charts, and re-exporting it wrote a file with no
 * charts either. Measured, before this module existed: 3 charts in → 0 charts in
 * the model → 0 charts out, with no warning anywhere. That is the worst class of
 * bug — silent data loss — and it is what this module fixes.
 *
 * HOW. An .xlsx is a ZIP of XML parts and JSZip is already a dependency (the
 * exporter post-processes the package with it), so we open the same package and
 * parse the chart parts ourselves, mapping each one back onto the chart
 * descriptor charts.js already defines.
 *
 * WHAT IT WILL NOT DO — IT WILL NOT GUESS. Our descriptor is deliberately small:
 * one CONTIGUOUS source range, columns = series, rows = categories (see
 * extractChartData). A real Excel chart can be shaped in ways that model cannot
 * express (series pulled from non-adjacent columns, series laid out in rows, data
 * on a different worksheet, a radar/stock/surface plot). Where a chart cannot be
 * represented FAITHFULLY, this module does NOT approximate it into something that
 * looks plausible but plots different numbers — it reports the chart as
 * unreadable, with the reason, so the caller can TELL THE USER rather than
 * quietly hand them a wrong chart or no chart.
 *
 * SECURITY. The file is untrusted. XML is parsed with DOMParser as text/xml
 * (browsers do not expand external entities, so no XXE/billion-laughs surface),
 * every descriptor leaves through charts.js `makeChart` — the same fail-closed
 * clamp used at the CRDT ingress (unknown type → column, geometry clamped, text
 * length-capped) — and part counts/sizes are bounded so a hostile package cannot
 * drive an unbounded parse. Nothing here is eval'd and nothing builds HTML.
 */
import JSZip from 'jszip'
import { makeChart } from './charts.js'
import { EMU_PER_PX, DEFAULT_COL_PX, DEFAULT_ROW_PX } from './xlsxCharts.js'

/** A parsed `'Sheet'!$B$2:$B$9`-style A1 reference (0-based, sorted). */
export interface ParsedRef {
  sheet: string
  r0: number
  r1: number
  c0: number
  c1: number
}

/** One chart series' cell references. */
export interface SeriesRef {
  val: ParsedRef | null
  cat: ParsedRef | null
  tx: ParsedRef | null
}

export type ChartTypeResult = { type: string; error?: undefined } | { error: string; type?: undefined }
export type RangeShapeResult =
  | { range: string; headerRow: boolean; headerCol: boolean; error?: undefined }
  | { error: string; range?: undefined; headerRow?: undefined; headerCol?: undefined }

export interface Geometry { x: number; y: number; w: number; h: number }

export interface UnreadableChart { title: string; reason: string }

export type ChartDescriptor = ReturnType<typeof makeChart>

export interface ReadXlsxChartsResult {
  charts: ChartDescriptor[]
  unreadable: UnreadableChart[]
  pivots: number
}

/** Bounds — a hostile package must not drive an unbounded parse. */
const MAX_CHART_PARTS = 50
const MAX_SERIES = 30
const MAX_PART_BYTES = 4 * 1024 * 1024

// ── tiny namespace-agnostic DOM helpers ─────────────────────────────────────
// Chart XML always uses the `c:` prefix in practice, but a prefix is not part of
// the contract — match on localName so any conforming producer parses.

function kids(el: Element | null | undefined, local: string): Element[] {
  if (!el) return []
  const out: Element[] = []
  for (const child of el.children || []) if (child.localName === local) out.push(child)
  return out
}
function kid(el: Element | null | undefined, local: string): Element | null { return kids(el, local)[0] || null }
/** First DESCENDANT with this localName (depth-first). */
function desc(el: Element | null | undefined, local: string): Element | null {
  if (!el) return null
  for (const child of el.children || []) {
    if (child.localName === local) return child
    const found = desc(child, local)
    if (found) return found
  }
  return null
}
function attr(el: Element | null | undefined, name: string): string | null { return el?.getAttribute?.(name) ?? null }
/** `<c:something val="x"/>` → "x" */
function valOf(el: Element | null | undefined, local: string): string | null { return attr(kid(el, local), 'val') }
/** All a:t runs under a title/rich element, joined — the visible text. */
function richText(el: Element | null | undefined): string {
  if (!el) return ''
  const out: string[] = []
  const walk = (n: Element) => {
    for (const child of n.children || []) {
      if (child.localName === 't') out.push(child.textContent || '')
      else walk(child)
    }
  }
  walk(el)
  return out.join('').trim()
}

// ── A1 reference parsing ────────────────────────────────────────────────────

function colIndex(letters: string): number {
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/**
 * parseRef — `'My Sheet'!$B$2:$B$9` → { sheet, r0, c0, r1, c1 } (0-based, sorted).
 * Returns null for anything we will not gamble on: a 3-D range (Sheet1:Sheet3!),
 * a table/defined-name reference, a whole-column ref, a formula. A null here
 * becomes an honest "cannot read this chart", never a guess.
 */
export function parseRef(f: unknown): ParsedRef | null {
  if (typeof f !== 'string') return null
  const m = /^(?:'((?:[^']|'')+)'|([^'!:]+))!\$?([A-Z]{1,3})\$?(\d{1,7})(?::\$?([A-Z]{1,3})\$?(\d{1,7}))?$/i.exec(f.trim())
  if (!m) return null
  const sheet = m[1] != null ? m[1].replace(/''/g, "'") : m[2]
  const a = { r: Number(m[4]) - 1, c: colIndex(m[3]) }
  const b = m[5] != null ? { r: Number(m[6]) - 1, c: colIndex(m[5]) } : a
  return {
    sheet,
    r0: Math.min(a.r, b.r), r1: Math.max(a.r, b.r),
    c0: Math.min(a.c, b.c), c1: Math.max(a.c, b.c),
  }
}

function colLetter(c: number): string {
  let s = ''
  let n = c
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1 } while (n >= 0)
  return s
}
function a1(r0: number, c0: number, r1: number, c1: number): string { return `${colLetter(c0)}${r0 + 1}:${colLetter(c1)}${r1 + 1}` }

/** The `<c:f>` inside a c:tx / c:cat / c:val / c:xVal … wrapper, if it has one. */
function refIn(wrapper: Element | null | undefined): ParsedRef | null {
  if (!wrapper) return null
  const f = desc(wrapper, 'f')
  return f ? parseRef(f.textContent || '') : null
}

// ── chart type ──────────────────────────────────────────────────────────────

const GROUPING_SUFFIX: Record<string, string> = { clustered: '', standard: '', stacked: '-stacked', percentStacked: '-100' }

/** The plot-group elements we understand, in the order they appear in plotArea. */
const PLOT_GROUPS = new Set([
  'barChart', 'lineChart', 'areaChart', 'pieChart', 'doughnutChart', 'scatterChart', 'bubbleChart',
])

/**
 * chartTypeOf — the plot groups of one chart part → our descriptor type.
 * Returns { type } or { error } — never a silent fallback: an unmapped plot
 * (radar / stock / surface / 3-D / of-pie …) is an ERROR the user gets told about,
 * because rendering someone's radar chart as a column chart is a lie.
 */
export function chartTypeOf(groups: Element[]): ChartTypeResult {
  if (!groups.length) return { error: 'no recognisable plot' }

  if (groups.length === 1) {
    const g = groups[0]
    const name = g.localName
    if (name === 'barChart') {
      const dir = valOf(g, 'barDir') === 'bar' ? 'bar' : 'column'
      const grouping = valOf(g, 'grouping') || 'clustered'
      const suffix = GROUPING_SUFFIX[grouping]
      if (suffix === undefined) return { error: `bar grouping “${grouping}” has no Vulos equivalent` }
      return { type: `${dir}${suffix}` }
    }
    if (name === 'lineChart') return { type: 'line' }
    if (name === 'areaChart') return { type: 'area' }
    if (name === 'pieChart') return { type: 'pie' }
    if (name === 'doughnutChart') return { type: 'donut' }
    if (name === 'scatterChart') return { type: 'scatter' }
    if (name === 'bubbleChart') return { type: 'bubble' }
    return { error: `${name.replace(/Chart$/, '')} charts aren’t supported` }
  }

  // Two groups = a combo. Ours is specifically "first series columns, the rest
  // lines", so only that exact shape maps; anything else would misplot.
  if (groups.length === 2) {
    const names = groups.map((g) => g.localName)
    const bar = groups[names.indexOf('barChart')]
    const line = groups[names.indexOf('lineChart')]
    if (bar && line) {
      if (kids(bar, 'ser').length !== 1) {
        return { error: 'combo charts with more than one column series aren’t supported' }
      }
      return { type: 'combo' }
    }
  }
  return { error: 'a mixed plot Vulos can’t represent' }
}

// ── series → one contiguous range ───────────────────────────────────────────

/**
 * rangeFromSeries — fold the series' cell references back into the single
 * contiguous `range` + headerRow/headerCol our descriptor holds.
 *
 * This is where we refuse to guess. It succeeds only when the references really
 * do describe one rectangle laid out the way extractChartData reads it:
 *   · every reference on the SAME sheet (and that sheet is the one the charts
 *     will be attached to — our charts read the first sheet's cells);
 *   · every value reference a single COLUMN (series-in-rows can't be expressed);
 *   · the value columns CONTIGUOUS and ascending (a gap would silently pull an
 *     unrelated column in as an extra series);
 *   · the category column, if any, immediately left of the first value column.
 * Anything else → { error }, which the caller reports to the user.
 */
export function rangeFromSeries(series: SeriesRef[], sheetName: string | null | undefined): RangeShapeResult {
  if (!series.length) return { error: 'no data series' }

  const sheets = new Set<string>()
  for (const s of series) {
    for (const ref of [s.val, s.cat, s.tx].filter((r): r is ParsedRef => !!r)) sheets.add(ref.sheet)
  }
  if (sheets.size > 1) return { error: 'its series read from more than one sheet' }
  const only = [...sheets][0]
  if (only != null && sheetName != null && only !== sheetName) {
    return { error: `its data is on another sheet (“${only}”)` }
  }

  const vals = series.map((s) => s.val)
  if (vals.some((v) => !v)) return { error: 'a series has no cell reference' }
  const valRefs = vals as ParsedRef[]
  if (valRefs.some((v) => v.c0 !== v.c1)) return { error: 'its series run across rows, not down columns' }

  const r0 = valRefs[0].r0
  const r1 = valRefs[0].r1
  if (valRefs.some((v) => v.r0 !== r0 || v.r1 !== r1)) return { error: 'its series cover different rows' }

  const cols = valRefs.map((v) => v.c0)
  const sorted = [...cols].sort((a, b) => a - b)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1] + 1) return { error: 'its series come from non-adjacent columns' }
  }
  // Series order must match column order, or the colours/legend would be shuffled
  // against the data on re-export.
  if (cols.some((c, i) => c !== sorted[i])) return { error: 'its series are not in column order' }

  const firstValCol = sorted[0]
  const lastValCol = sorted[sorted.length - 1]

  // Category column: must sit immediately left of the values, and cover the same
  // rows — that is exactly the shape extractChartData reads as headerCol.
  const cat = series.find((s) => s.cat)?.cat || null
  let c0 = firstValCol
  let headerCol = false
  if (cat) {
    if (cat.c0 !== cat.c1) return { error: 'its category labels span several columns' }
    if (cat.c0 !== firstValCol - 1) return { error: 'its category labels are not next to the data' }
    if (cat.r0 !== r0 || cat.r1 !== r1) return { error: 'its category labels cover different rows' }
    c0 = cat.c0
    headerCol = true
  }

  // Header row: series names taken from the cells directly above the values.
  const txs = series.map((s) => s.tx).filter((t): t is ParsedRef => !!t)
  let rTop = r0
  let headerRow = false
  if (txs.length === series.length &&
      txs.every((t, i) => t.r0 === t.r1 && t.r0 === r0 - 1 && t.c0 === t.c1 && t.c0 === cols[i])) {
    rTop = r0 - 1
    headerRow = true
  }

  return { range: a1(rTop, c0, r1, lastValCol), headerRow, headerCol }
}

// ── drawing anchors → position/size ─────────────────────────────────────────

const px = (v: unknown): number => Math.round(Number(v || 0) / EMU_PER_PX)

function anchorPoint(el: Element | null | undefined): { x: number; y: number } | null {
  if (!el) return null
  const col = Number(kid(el, 'col')?.textContent || 0)
  const row = Number(kid(el, 'row')?.textContent || 0)
  const colOff = Number(kid(el, 'colOff')?.textContent || 0)
  const rowOff = Number(kid(el, 'rowOff')?.textContent || 0)
  if (!isFinite(col) || !isFinite(row)) return null
  return { x: col * DEFAULT_COL_PX + px(colOff), y: row * DEFAULT_ROW_PX + px(rowOff) }
}

/**
 * geometryOf — an anchor element → { x, y, w, h } in px, or null.
 * Column widths in the source file are not ours, so this is an APPROXIMATION of
 * where the chart floated; it only affects placement, never the plotted numbers,
 * and makeChart clamps it to sane bounds regardless.
 */
export function geometryOf(anchor: Element | null | undefined): Geometry | null {
  const from = anchorPoint(kid(anchor, 'from'))
  const ext = kid(anchor, 'ext')
  if (ext) {
    const w = px(attr(ext, 'cx'))
    const h = px(attr(ext, 'cy'))
    const pos = kid(anchor, 'pos')
    const at = from || (pos ? { x: px(attr(pos, 'x')), y: px(attr(pos, 'y')) } : null)
    if (!at) return null
    return { x: at.x, y: at.y, w, h }
  }
  const to = anchorPoint(kid(anchor, 'to'))
  if (!from || !to) return null
  return { x: from.x, y: from.y, w: to.x - from.x, h: to.y - from.y }
}

// ── package walk ────────────────────────────────────────────────────────────

/**
 * Resolve a relationship Target against the part that declared it.
 * A Target may be relative ("../charts/chart1.xml") OR package-absolute
 * ("/xl/charts/chart1.xml") — openpyxl writes the latter — so an absolute target
 * must NOT be joined onto the declaring part's directory.
 */
function resolveTarget(basePath: string, target: unknown): string {
  const raw = typeof target === 'string' ? target : ''
  if (raw.startsWith('/')) return raw.slice(1)
  const baseDir = basePath.replace(/\/[^/]*$/, '')
  const parts = `${baseDir}/${raw}`.split('/')
  const out: string[] = []
  for (const p of parts) {
    if (p === '.' || p === '') continue
    if (p === '..') out.pop()
    else out.push(p)
  }
  return out.join('/')
}

type ParseXmlFn = (text: string) => Document | null

/** Map every chart part path → its drawing anchor geometry (best effort). */
async function chartGeometry(zip: JSZip, parseXml: ParseXmlFn): Promise<Map<string, Geometry>> {
  const map = new Map<string, Geometry>()
  const drawings = Object.keys(zip.files).filter((n) => /^xl\/drawings\/drawing\d+\.xml$/i.test(n))
  for (const path of drawings.slice(0, MAX_CHART_PARTS)) {
    const relsPath = path.replace(/drawings\/([^/]+)$/, 'drawings/_rels/$1.rels')
    const relsFile = zip.file(relsPath)
    if (!relsFile) continue
    const relsDoc = parseXml(await relsFile.async('string'))
    const rels = new Map<string, string>()
    for (const rel of relsDoc?.documentElement?.children || []) {
      const id = attr(rel, 'Id')
      if (id) rels.set(id, resolveTarget(path, attr(rel, 'Target')))
    }
    const chartFile = zip.file(path)
    if (!chartFile) continue
    const doc = parseXml(await chartFile.async('string'))
    if (!doc) continue
    for (const anchor of doc.documentElement?.children || []) {
      const frame = desc(anchor, 'graphicFrame')
      if (!frame) continue
      const chartEl = desc(frame, 'chart')
      if (!chartEl) continue
      // r:id — read prefix-agnostically (the attribute is namespaced).
      const rid = attr(chartEl, 'r:id') || attr(chartEl, 'id') ||
        [...(chartEl.attributes || [])].find((a) => a.localName === 'id')?.value
      const target = rid ? rels.get(rid) : undefined
      if (!target) continue
      const geom = geometryOf(anchor)
      if (geom) map.set(target, geom)
    }
  }
  return map
}

/**
 * readXlsxCharts — the public entry point.
 *
 * @param bytes      Uint8Array/ArrayBuffer of the .xlsx package
 * @param sheetName  the worksheet our charts will read cells from (charts are
 *                   bound to the first sheet — see charts.js getCharts). A chart
 *                   whose data lives elsewhere is reported, not faked.
 * @param cellAt     (r, c) → display string, used to resolve a title held in a
 *                   cell (`<c:tx><c:strRef>`) rather than typed into the chart.
 *
 * @returns { charts, unreadable: [{ title, reason }], pivots }
 *   charts     — descriptors ready for sheet.charts (already makeChart-clamped)
 *   unreadable — charts we could NOT represent faithfully, with a plain reason
 *   pivots     — how many pivot TABLES the package holds (we import their cells,
 *                but not the live pivot object — the caller says so out loud)
 *
 * Never throws on a malformed package: a chart we cannot parse is reported as
 * unreadable, and a package we cannot open at all yields empty results, because
 * failing an import outright over a decorative part would be worse than the
 * cells arriving without it.
 */
export async function readXlsxCharts(
  bytes: Parameters<typeof JSZip.loadAsync>[0],
  sheetName: string | null | undefined,
  cellAt: ((r: number, c: number) => unknown) | null | undefined,
): Promise<ReadXlsxChartsResult> {
  const empty: ReadXlsxChartsResult = { charts: [], unreadable: [], pivots: 0 }
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch {
    return empty
  }

  const names = Object.keys(zip.files)
  const pivots = names.filter((n) => /^xl\/pivotTables\/pivotTable\d+\.xml$/i.test(n)).length

  const parser = typeof DOMParser !== 'undefined' ? new DOMParser() : null
  if (!parser) return { ...empty, pivots }
  const parseXml: ParseXmlFn = (text) => {
    try {
      const doc = parser.parseFromString(text, 'text/xml')
      if (doc.getElementsByTagName('parsererror').length) return null
      return doc
    } catch { return null }
  }

  const chartPaths = names
    .filter((n) => /^xl\/charts\/chart\d+\.xml$/i.test(n))
    .sort()
    .slice(0, MAX_CHART_PARTS)
  if (!chartPaths.length) return { ...empty, pivots }

  let geometry = new Map<string, Geometry>()
  try { geometry = await chartGeometry(zip, parseXml) } catch { /* placement only */ }

  const charts: ChartDescriptor[] = []
  const unreadable: UnreadableChart[] = []

  for (const path of chartPaths) {
    let doc: Document | null = null
    try {
      const file = zip.file(path)
      const raw = file ? await file.async('string') : ''
      if (raw.length > MAX_PART_BYTES) { unreadable.push({ title: '', reason: 'the chart part is too large to parse' }); continue }
      doc = parseXml(raw)
    } catch { doc = null }
    if (!doc) { unreadable.push({ title: '', reason: 'its chart data could not be parsed' }); continue }

    // c:chart is a direct child of c:chartSpace; fall back to a search only if a
    // producer nests it unusually (never match a deeper, unrelated <chart>).
    const chartEl = kid(doc.documentElement, 'chart') || desc(doc.documentElement, 'chart')
    const plotArea = kid(chartEl, 'plotArea')
    if (!plotArea) { unreadable.push({ title: '', reason: 'it has no plot area' }); continue }

    // Title: rich text, or a cell reference we resolve against the sheet.
    const titleEl = kid(chartEl, 'title')
    let title = richText(kid(titleEl, 'tx') || titleEl)
    if (!title && titleEl && typeof cellAt === 'function') {
      const ref = refIn(kid(titleEl, 'tx'))
      if (ref) {
        const cell: unknown = cellAt(ref.r0, ref.c0)
        title = typeof cell === 'string' || typeof cell === 'number' ? String(cell) : ''
      }
    }

    const groups = [...(plotArea.children || [])].filter((el) => PLOT_GROUPS.has(el.localName) || /Chart$/.test(el.localName))
    const t = chartTypeOf(groups)
    if (t.error) { unreadable.push({ title, reason: t.error }); continue }
    const isXY = t.type === 'scatter' || t.type === 'bubble'

    // Series — in plot-group order (combo: the column series first, as we render it).
    const sers: SeriesRef[] = []
    for (const g of groups) {
      for (const ser of kids(g, 'ser')) {
        if (sers.length >= MAX_SERIES) break
        if (isXY) {
          // X/Y plots hold their columns in xVal/yVal(/bubbleSize). Our renderer
          // reads them POSITIONALLY as the first columns of the range, so they
          // become ordinary value columns here.
          const refs = [kid(ser, 'xVal'), kid(ser, 'yVal'), kid(ser, 'bubbleSize')]
            .map(refIn).filter((r): r is ParsedRef => !!r)
          for (const ref of refs) sers.push({ val: ref, cat: null, tx: null })
        } else {
          sers.push({
            val: refIn(kid(ser, 'val')),
            cat: refIn(kid(ser, 'cat')),
            tx: refIn(kid(ser, 'tx')),
          })
        }
      }
    }
    if (!sers.length) {
      // A chart whose numbers are baked into the part (c:numLit) instead of
      // referencing cells — our own histogram export is written that way. There
      // are no cells to point at, so it cannot become a live Vulos chart.
      unreadable.push({ title, reason: 'its values are stored in the chart, not in cells' })
      continue
    }

    const shape = rangeFromSeries(sers, sheetName)
    if (shape.error) { unreadable.push({ title, reason: shape.error }); continue }

    // Axis titles. A category plot has one value axis (Y) and a category axis (X);
    // an X/Y plot has two value axes, X first.
    const valAxes = kids(plotArea, 'valAx')
    const xAxisLabel = isXY
      ? richText(kid(valAxes[0], 'title'))
      : richText(kid(kid(plotArea, 'catAx'), 'title'))
    const yAxisLabel = isXY
      ? richText(kid(valAxes[1] || valAxes[0], 'title'))
      : richText(kid(valAxes[0], 'title'))

    const geom = geometry.get(path) || {}
    charts.push(makeChart({
      type: t.type,
      range: shape.range,
      title,
      options: {
        // X/Y: the first column is X DATA, not a category-label column — telling
        // the renderer otherwise would drop the X values and plot the wrong points.
        headerCol: isXY ? false : shape.headerCol,
        headerRow: shape.headerRow,
        legend: !!kid(chartEl, 'legend'),
        xAxisLabel,
        yAxisLabel,
      },
      ...geom,
    }))
  }

  return { charts, unreadable, pivots }
}
