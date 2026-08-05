/**
 * src/apps/sheets/xlsxCharts.ts  (WAVE-64)
 *
 * REAL OOXML charts in the exported .xlsx — no heavyweight writer library.
 *
 * THE PROBLEM THIS SOLVES. SheetJS (community `xlsx`, our only spreadsheet
 * engine) can neither read nor WRITE chart parts: `XLSX.write` emits worksheets,
 * styles and nothing else. So every chart a user built in Vulos Sheets used to
 * vanish on export to Excel, recorded only in a side "Vulos Charts" metadata
 * worksheet. That is silent data loss.
 *
 * THE FIX. An .xlsx is just a ZIP of XML parts, and JSZip (already a dependency,
 * used by the docx/pptx paths) can open the buffer SheetJS produced. So we
 * POST-PROCESS the package: emit a genuine `xl/charts/chartN.xml` per chart, a
 * `xl/drawings/drawing1.xml` that anchors them over the grid, wire the
 * relationships (`worksheets/_rels`, `drawings/_rels`), declare the new content
 * types, and add the `<drawing>` element to the worksheet. The result is a chart
 * Excel/LibreOffice/Numbers render natively and RECALCULATES, because each
 * series points at the real cells (`'Sheet1'!$B$2:$B$9`) rather than at baked-in
 * numbers.
 *
 * FAIL-CLOSED. Injection NEVER corrupts a workbook to chase a chart:
 *   - a chart type with no faithful OOXML equivalent is reported as UNSUPPORTED
 *     and left to the metadata sheet (the caller warns the user) — we do not
 *     invent an approximation and pass it off as the user's chart;
 *   - an unparseable/unexpected package shape (e.g. a future SheetJS that ships
 *     its own drawings) aborts injection and returns the ORIGINAL buffer;
 *   - every string that reaches the XML is escapeChartText'd (untrusted cell
 *     data) and then XML-escaped, so a cell can neither break the markup nor
 *     smuggle a formula/entity. We never build a chart part from raw cell text.
 *
 * HISTOGRAM is the one type whose values are ours, not the sheet's (we compute
 * the bins). It is written with LITERAL cached values (c:numLit/c:strLit — part
 * of the same schema) instead of cell references, so it renders correctly in
 * Excel but does not recalculate there. The export dialog says so out loud.
 */
import JSZip from 'jszip'
import {
  escapeChartText, extractChartData, histogramBins, histogramValues, stackModeOf,
  isHorizontalBar, CHART_PALETTE,
  type Chart, type ChartSheet,
} from './charts.js'
import { parseRange } from './ConditionalFormatPanel.jsx'

// Exported so the READER (xlsxChartsRead.js) maps drawing anchors back to pixels
// with exactly the same constants the writer used — one mapping, both directions.
export const EMU_PER_PX = 9525
export const DEFAULT_COL_PX = 64
export const DEFAULT_ROW_PX = 20

export interface NativeXlsxSupport { native: boolean; note?: string }

interface SeriesRefBuild { nameRef: string | null; valRef: string; col: number }

export interface ChartRefs {
  r0: number
  r1: number
  c0: number
  c1: number
  dataR0: number
  dataC0: number
  catRef: string | null
  nCat: number
  series: SeriesRefBuild[]
}

export interface ChartAnchor { rId: string; x: number; y: number; w: number; h: number }

export interface SkippedChart { id: string; type: string; reason: string }

export interface InjectChartsResult {
  buffer: Parameters<typeof JSZip.loadAsync>[0]
  embedded: string[]
  skipped: SkippedChart[]
}

/** The `[{ row: [r0,r1], column: [c0,c1] }]` shape `parseRange` (ConditionalFormatPanel.jsx,
 * not yet converted) always returns — a local, explicit view of its contract. */
interface ParsedRangeRect { row: [number, number]; column: [number, number] }

/** Chart types we can express faithfully as OOXML. */
const NATIVE_TYPES = new Set([
  'column', 'bar', 'column-stacked', 'bar-stacked', 'column-100', 'bar-100',
  'line', 'area', 'combo', 'pie', 'donut', 'scatter', 'bubble', 'histogram',
])

/**
 * nativeXlsxSupport — can this chart become a real Excel chart?
 * Returns { native: boolean, note?: string } — `note` is a HONEST caveat shown
 * in the export dialog for a type that embeds with a caveat.
 */
export function nativeXlsxSupport(type: unknown): NativeXlsxSupport {
  if (typeof type !== 'string' || !NATIVE_TYPES.has(type)) return { native: false, note: 'no Excel equivalent' }
  if (type === 'histogram') {
    return { native: true, note: 'histogram bins are embedded as fixed values — Excel will not re-bin them if the data changes' }
  }
  return { native: true }
}

// ── XML helpers ─────────────────────────────────────────────────────────────

/** XML text escape. Applied to EVERY interpolated string, always. */
export function xmlEscape(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Safe display text for an untrusted (cell-derived) string, then XML-escaped. */
function safeText(v: unknown, max = 200): string {
  return xmlEscape(escapeChartText(v, max))
}

function colLetter(c: number): string {
  let s = ''
  let n = c
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1 } while (n >= 0)
  return s
}

/**
 * absRef — `'My Sheet'!$B$2:$B$9`. The sheet name is quoted and its internal
 * apostrophes are doubled (the A1 escaping rule), then only the XML-significant
 * characters are entity-encoded: `'` is legal in XML element text, and encoding
 * it would leave every reference full of &apos; noise for other readers.
 */
export function absRef(sheetName: string | null | undefined, c0: number, r0: number, c1: number, r1: number): string {
  const name = String(sheetName || 'Sheet1').replace(/'/g, "''")
  const a = `$${colLetter(c0)}$${r0 + 1}`
  const b = `$${colLetter(c1)}$${r1 + 1}`
  const ref = `'${name}'!${a}${a === b ? '' : ':' + b}`
  return ref.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function richText(text: unknown, size = 1000, bold = 0): string {
  return `<c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${size}" b="${bold}"/></a:pPr>` +
    `<a:r><a:t>${safeText(text)}</a:t></a:r></a:p></c:rich>`
}

function titleXml(text: unknown): string {
  if (!text) return '<c:autoTitleDeleted val="1"/>'
  return `<c:title><c:tx>${richText(text, 1200, 1)}</c:tx><c:overlay val="0"/></c:title>` +
    '<c:autoTitleDeleted val="0"/>'
}

function axisTitleXml(text: unknown): string {
  if (!text) return ''
  return `<c:title><c:tx>${richText(text)}</c:tx><c:overlay val="0"/></c:title>`
}

function solidFill(hex: unknown): string {
  return `<c:spPr><a:solidFill><a:srgbClr val="${xmlEscape(String(hex).replace('#', '').toUpperCase())}"/></a:solidFill></c:spPr>`
}
function lineFill(hex: unknown): string {
  return `<c:spPr><a:ln w="22225" cap="rnd"><a:solidFill>` +
    `<a:srgbClr val="${xmlEscape(String(hex).replace('#', '').toUpperCase())}"/></a:solidFill><a:round/></a:ln></c:spPr>`
}

/** c:numLit / c:strLit — literal cached values (used by the histogram). */
function numLit(values: unknown[]): string {
  const pts = values.map((v, i) => `<c:pt idx="${i}"><c:v>${Number(v) || 0}</c:v></c:pt>`).join('')
  return `<c:numLit><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${pts}</c:numLit>`
}
function strLit(values: unknown[]): string {
  const pts = values.map((v, i) => `<c:pt idx="${i}"><c:v>${safeText(v, 60)}</c:v></c:pt>`).join('')
  return `<c:strLit><c:ptCount val="${values.length}"/>${pts}</c:strLit>`
}

// ── Range geometry (mirrors extractChartData's reading of the descriptor) ────

/**
 * chartRefs — resolve a chart descriptor's range into the concrete cell
 * references its series/categories point at. Returns null when the range is
 * unusable, so a bad range is skipped rather than emitted as a broken part.
 */
export function chartRefs(chart: Chart, sheetName: string | null | undefined): ChartRefs | null {
  let parsed: ParsedRangeRect | undefined
  try { parsed = parseRange(String(chart?.range || ''))?.[0] as ParsedRangeRect | undefined } catch { return null }
  if (!parsed) return null
  const [r0, r1raw] = parsed.row
  const [c0, c1raw] = parsed.column
  if (![r0, r1raw, c0, c1raw].every((n) => Number.isFinite(n) && n >= 0)) return null
  const rows = Math.min(r1raw - r0 + 1, 1000)
  const cols = Math.min(c1raw - c0 + 1, 100)
  if (rows <= 0 || cols <= 0) return null
  const r1 = r0 + rows - 1
  const c1 = c0 + cols - 1

  const opt = chart.options || {}
  const hasHeaderRow = opt.headerRow !== false && rows > 1
  const hasHeaderCol = opt.headerCol !== false && cols > 1
  const dataR0 = hasHeaderRow ? r0 + 1 : r0
  const dataC0 = hasHeaderCol ? c0 + 1 : c0
  if (dataR0 > r1 || dataC0 > c1) return null

  const series: SeriesRefBuild[] = []
  for (let c = dataC0; c <= c1; c++) {
    series.push({
      nameRef: hasHeaderRow ? absRef(sheetName, c, r0, c, r0) : null,
      valRef:  absRef(sheetName, c, dataR0, c, r1),
      col: c,
    })
  }
  return {
    r0, r1, c0, c1, dataR0, dataC0,
    catRef: hasHeaderCol ? absRef(sheetName, c0, dataR0, c0, r1) : null,
    nCat: r1 - dataR0 + 1,
    series,
  }
}

// ── Series builders ─────────────────────────────────────────────────────────

function serTx(ref: string | null, fallback: string): string {
  if (ref) return `<c:tx><c:strRef><c:f>${ref}</c:f></c:strRef></c:tx>`
  return `<c:tx><c:v>${safeText(fallback)}</c:v></c:tx>`
}

function catXml(refs: ChartRefs): string {
  if (refs.catRef) return `<c:cat><c:strRef><c:f>${refs.catRef}</c:f></c:strRef></c:cat>`
  // No label column: number the categories 1..n as literals (a chart with no
  // category axis values renders with empty ticks in Excel).
  return `<c:cat>${numLit(Array.from({ length: Math.max(0, refs.nCat) }, (_, i) => i + 1))}</c:cat>`
}

function valXml(ref: string): string {
  return `<c:val><c:numRef><c:f>${ref}</c:f></c:numRef></c:val>`
}

function barSer(s: SeriesRefBuild, i: number, refs: ChartRefs, color: string): string {
  return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${serTx(s.nameRef, `Series ${i + 1}`)}` +
    `${solidFill(color)}<c:invertIfNegative val="0"/>${catXml(refs)}${valXml(s.valRef)}</c:ser>`
}
function lineSer(s: SeriesRefBuild, i: number, refs: ChartRefs, color: string): string {
  return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${serTx(s.nameRef, `Series ${i + 1}`)}` +
    `${lineFill(color)}<c:marker><c:symbol val="circle"/><c:size val="5"/>${solidFill(color)}</c:marker>` +
    `${catXml(refs)}${valXml(s.valRef)}<c:smooth val="0"/></c:ser>`
}
function areaSer(s: SeriesRefBuild, i: number, refs: ChartRefs, color: string): string {
  return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${serTx(s.nameRef, `Series ${i + 1}`)}` +
    `${solidFill(color)}${catXml(refs)}${valXml(s.valRef)}</c:ser>`
}
function pieSer(s: SeriesRefBuild, i: number, refs: ChartRefs, nCatColors: number): string {
  const dPts = Array.from({ length: nCatColors }, (_, k) =>
    `<c:dPt><c:idx val="${k}"/><c:bubble3D val="0"/>${solidFill(CHART_PALETTE[k % CHART_PALETTE.length])}</c:dPt>`
  ).join('')
  return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${serTx(s.nameRef, `Series ${i + 1}`)}` +
    `${dPts}${catXml(refs)}${valXml(s.valRef)}</c:ser>`
}

// ── Axes ────────────────────────────────────────────────────────────────────

interface AxOpts {
  pos?: string
  label?: string
  deleted?: boolean
  percent?: boolean
  crossesMax?: boolean
  gridlines?: boolean
}

function catAx(id: number, crossId: number, { pos = 'b', label = '', deleted = false }: AxOpts = {}): string {
  return `<c:catAx><c:axId val="${id}"/><c:scaling><c:orientation val="minMax"/></c:scaling>` +
    `<c:delete val="${deleted ? 1 : 0}"/><c:axPos val="${pos}"/>${axisTitleXml(label)}` +
    '<c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>' +
    `<c:crossAx val="${crossId}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/>` +
    '<c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>'
}

function valAx(id: number, crossId: number, { pos = 'l', label = '', percent = false, crossesMax = false, gridlines = true }: AxOpts = {}): string {
  return `<c:valAx><c:axId val="${id}"/><c:scaling><c:orientation val="minMax"/></c:scaling>` +
    `<c:delete val="0"/><c:axPos val="${pos}"/>${gridlines ? '<c:majorGridlines/>' : ''}` +
    `${axisTitleXml(label)}<c:numFmt formatCode="${percent ? '0%' : 'General'}" sourceLinked="0"/>` +
    '<c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>' +
    `<c:crossAx val="${crossId}"/><c:crosses val="${crossesMax ? 'max' : 'autoZero'}"/>` +
    '<c:crossBetween val="between"/></c:valAx>'
}

/** X/Y (scatter, bubble) both value axes. */
function xyAxes(xLabel: string, yLabel: string): string {
  return valAx(10, 20, { pos: 'b', label: xLabel, gridlines: false }) +
    valAx(20, 10, { pos: 'l', label: yLabel })
}

// ── The chart part ──────────────────────────────────────────────────────────

/**
 * chartPartXml — the full `xl/charts/chartN.xml` for one descriptor.
 * PURE: descriptor + sheet → string. Returns null for a chart that cannot be
 * expressed (unknown type / unusable range) — the caller then reports the loss.
 */
export function chartPartXml(chart: Chart, sheet: ChartSheet, sheetName: string | null | undefined): string | null {
  if (!nativeXlsxSupport(chart?.type).native) return null
  const refs = chartRefs(chart, sheetName)
  if (!refs || !refs.series.length) return null

  const opt = chart.options || {}
  const legend = opt.legend !== false
    ? '<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend>'
    : ''
  const xLabel = opt.xAxisLabel || ''
  const yLabel = opt.yAxisLabel || ''
  const color = (i: number) => CHART_PALETTE[i % CHART_PALETTE.length]

  let plot = ''
  const type = chart.type

  if (type === 'histogram') {
    // Bins are OUR computation, so they ride as literal values (see the header).
    const extracted = extractChartData(chart, sheet)
    const { bins } = histogramBins(histogramValues(extracted), opt.bins)
    if (!bins.length) return null
    const ser = `<c:ser><c:idx val="0"/><c:order val="0"/>` +
      `<c:tx><c:v>${safeText(extracted.series[0]?.name || 'Frequency')}</c:v></c:tx>` +
      `${solidFill(color(0))}<c:invertIfNegative val="0"/>` +
      `<c:cat>${strLit(bins.map((b) => b.label))}</c:cat>` +
      `<c:val>${numLit(bins.map((b) => b.count))}</c:val></c:ser>`
    plot = '<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>' +
      `${ser}<c:gapWidth val="0"/><c:axId val="10"/><c:axId val="20"/></c:barChart>` +
      catAx(10, 20, { label: xLabel }) +
      valAx(20, 10, { label: yLabel || 'Frequency' })
  } else if (type === 'pie' || type === 'donut') {
    const s = refs.series[0]
    const ser = pieSer(s, 0, refs, Math.max(1, refs.nCat))
    plot = type === 'donut'
      ? `<c:doughnutChart><c:varyColors val="1"/>${ser}<c:firstSliceAng val="0"/><c:holeSize val="55"/></c:doughnutChart>`
      : `<c:pieChart><c:varyColors val="1"/>${ser}<c:firstSliceAng val="0"/></c:pieChart>`
  } else if (type === 'scatter' || type === 'bubble') {
    const [sx, sy, ss] = refs.series
    if (!sx || !sy) return null
    if (type === 'scatter') {
      const ser = `<c:ser><c:idx val="0"/><c:order val="0"/>${serTx(sy.nameRef, 'Series 1')}` +
        `<c:spPr><a:ln w="28575"><a:noFill/></a:ln></c:spPr>` +
        `<c:marker><c:symbol val="circle"/><c:size val="6"/>${solidFill(color(0))}</c:marker>` +
        `<c:xVal><c:numRef><c:f>${sx.valRef}</c:f></c:numRef></c:xVal>` +
        `<c:yVal><c:numRef><c:f>${sy.valRef}</c:f></c:numRef></c:yVal><c:smooth val="0"/></c:ser>`
      plot = '<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>' +
        `${ser}<c:axId val="10"/><c:axId val="20"/></c:scatterChart>` + xyAxes(xLabel, yLabel)
    } else {
      if (!ss) return null   // bubble needs a size column; without it we do not fake one
      const ser = `<c:ser><c:idx val="0"/><c:order val="0"/>${serTx(sy.nameRef, 'Series 1')}` +
        `${solidFill(color(0))}<c:invertIfNegative val="0"/>` +
        `<c:xVal><c:numRef><c:f>${sx.valRef}</c:f></c:numRef></c:xVal>` +
        `<c:yVal><c:numRef><c:f>${sy.valRef}</c:f></c:numRef></c:yVal>` +
        `<c:bubbleSize><c:numRef><c:f>${ss.valRef}</c:f></c:numRef></c:bubbleSize>` +
        '<c:bubble3D val="0"/></c:ser>'
      plot = `<c:bubbleChart><c:varyColors val="0"/>${ser}<c:bubble3D val="0"/>` +
        '<c:bubbleScale val="100"/><c:showNegBubbles val="0"/><c:axId val="10"/><c:axId val="20"/></c:bubbleChart>' +
        xyAxes(xLabel, yLabel)
    }
  } else if (type === 'line' || type === 'area') {
    const sers = refs.series.map((s, i) => (type === 'line' ? lineSer(s, i, refs, color(i)) : areaSer(s, i, refs, color(i)))).join('')
    const tag = type === 'line' ? 'lineChart' : 'areaChart'
    const extra = type === 'line' ? '<c:marker val="1"/>' : ''
    plot = `<c:${tag}><c:grouping val="standard"/><c:varyColors val="0"/>${sers}${extra}` +
      `<c:axId val="10"/><c:axId val="20"/></c:${tag}>` +
      catAx(10, 20, { label: xLabel }) + valAx(20, 10, { label: yLabel })
  } else if (type === 'combo') {
    // series[0] as columns; series[1..] as lines, optionally on their own axis.
    const bars = barSer(refs.series[0], 0, refs, color(0))
    const lines = refs.series.slice(1)
    const secondary = opt.secondaryAxis === true && lines.length > 0
    const lineAxA = secondary ? 30 : 10
    const lineAxB = secondary ? 40 : 20
    const lineSers = lines.map((s, i) => lineSer(s, i + 1, refs, color(i + 1))).join('')
    plot = '<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>' +
      `${bars}<c:gapWidth val="150"/><c:axId val="10"/><c:axId val="20"/></c:barChart>`
    if (lines.length) {
      plot += '<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>' +
        `${lineSers}<c:marker val="1"/><c:axId val="${lineAxA}"/><c:axId val="${lineAxB}"/></c:lineChart>`
    }
    plot += catAx(10, 20, { label: xLabel }) + valAx(20, 10, { label: yLabel })
    if (secondary) {
      // The secondary pair: a hidden category axis + a right-hand value axis that
      // crosses the category axis at its maximum (that is what puts it on the right).
      plot += catAx(30, 40, { pos: 'b', deleted: true }) +
        valAx(40, 30, { pos: 'r', label: opt.y2AxisLabel || '', crossesMax: true, gridlines: false })
    }
  } else {
    // column / bar family, incl. stacked + 100% stacked.
    const mode = stackModeOf(type)
    const grouping = mode === 'stacked' ? 'stacked' : mode === 'percent' ? 'percentStacked' : 'clustered'
    const dir = isHorizontalBar(type) ? 'bar' : 'col'
    const sers = refs.series.map((s, i) => barSer(s, i, refs, color(i))).join('')
    const overlap = mode === 'none' ? -27 : 100
    plot = `<c:barChart><c:barDir val="${dir}"/><c:grouping val="${grouping}"/><c:varyColors val="0"/>` +
      `${sers}<c:gapWidth val="150"/><c:overlap val="${overlap}"/>` +
      '<c:axId val="10"/><c:axId val="20"/></c:barChart>' +
      catAx(10, 20, { pos: dir === 'bar' ? 'l' : 'b', label: xLabel }) +
      valAx(20, 10, { pos: dir === 'bar' ? 'b' : 'l', label: yLabel, percent: mode === 'percent' })
  }

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<c:date1904 val="0"/><c:roundedCorners val="0"/>' +
    `<c:chart>${titleXml(chart.title)}<c:plotArea><c:layout/>${plot}</c:plotArea>${legend}` +
    '<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>' +
    '<c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></c:spPr>' +
    '</c:chartSpace>'
}

/**
 * drawing1.xml — anchors every chart part over the grid at its saved position.
 *
 * The geometry is re-clamped here (not merely trusted from the descriptor): a
 * NaN/absurd size would otherwise become a NaN EMU extent, which is the one way
 * a drawing part can make Excel reject the whole package.
 */
export function drawingXml(anchors: ChartAnchor[]): string {
  const clamp = (v: unknown, dflt: number, lo: number, hi: number): number => {
    const n = Number(v)
    if (!isFinite(n) || n <= 0) return dflt
    return Math.min(hi, Math.max(lo, n))
  }
  const body = anchors.map((a, i) => {
    const x = clamp(a.x, 0, 0, 100000)
    const y = clamp(a.y, 0, 0, 100000)
    const col = Math.max(0, Math.round(x / DEFAULT_COL_PX))
    const row = Math.max(0, Math.round(y / DEFAULT_ROW_PX))
    const cx = Math.round(clamp(a.w, 480, 160, 4000) * EMU_PER_PX)
    const cy = Math.round(clamp(a.h, 300, 120, 4000) * EMU_PER_PX)
    return '<xdr:oneCellAnchor>' +
      `<xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff>` +
      `<xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
      `<xdr:ext cx="${cx}" cy="${cy}"/>` +
      '<xdr:graphicFrame macro="">' +
      `<xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="Chart ${i + 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
      '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
      `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${xmlEscape(a.rId)}"/>` +
      '</a:graphicData></a:graphic>' +
      '</xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor>'
  }).join('')
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${body}</xdr:wsDr>`
}

// ── Package surgery ─────────────────────────────────────────────────────────

const CT_CHART = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml'
const CT_DRAWING = 'application/vnd.openxmlformats-officedocument.drawing+xml'
const REL_DRAWING = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing'
const REL_CHART = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart'

interface FirstSheetPart { path: string; name: string }

/** Resolve the FIRST worksheet's part path + name from the package itself. */
function firstSheetPart(workbookXml: string, relsXml: string): FirstSheetPart | null {
  const sheetTag = workbookXml.match(/<sheet\b[^>]*\/>/)
  if (!sheetTag) return null
  const name = sheetTag[0].match(/name="([^"]*)"/)?.[1]
  const rid = sheetTag[0].match(/r:id="([^"]*)"/)?.[1]
  if (!name || !rid) return null
  const relRe = new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*>`)
  const rel = relsXml.match(relRe)?.[0]
  const target = rel?.match(/Target="([^"]*)"/)?.[1]
  if (!target) return null
  const path = target.startsWith('/') ? target.slice(1)
    : target.startsWith('xl/') ? target
    : 'xl/' + target.replace(/^\.\//, '')
  // Decode the XML entities SheetJS may have written into the name attribute.
  const decoded = name
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  return { path, name: decoded }
}

/** Insert <drawing/> in the schema-legal position (before the trailing parts). */
function insertDrawingElement(sheetXml: string, rId: string): string | null {
  const el = `<drawing r:id="${xmlEscape(rId)}"/>`
  // CT_Worksheet order: … ignoredErrors, smartTags, DRAWING, legacyDrawing…,
  // picture, oleObjects, controls, webPublishItems, tableParts, extLst.
  //
  // Only elements AFTER </sheetData> can follow <drawing>, so the scan starts
  // there: an `<extLst>` nested inside (say) a conditional-formatting rule earlier
  // in the document would otherwise drag the drawing in front of pageMargins —
  // out of schema order, which is exactly what makes Excel "repair" a file.
  const bodyEnd = sheetXml.indexOf('</sheetData>')
  const from = bodyEnd >= 0 ? bodyEnd : 0
  const after = ['<legacyDrawing', '<legacyDrawingHF', '<drawingHF', '<picture',
    '<oleObjects', '<controls', '<webPublishItems', '<tableParts', '<extLst']
  let at = -1
  for (const tag of after) {
    const i = sheetXml.indexOf(tag, from)
    if (i >= 0 && (at < 0 || i < at)) at = i
  }
  if (at < 0) at = sheetXml.lastIndexOf('</worksheet>')
  if (at < 0) return null
  return sheetXml.slice(0, at) + el + sheetXml.slice(at)
}

/** Next free rIdN in an existing rels part (or rId1 when there is none). */
function nextRelId(relsXml: string): string {
  let max = 0
  for (const m of relsXml.matchAll(/Id="rId(\d+)"/g)) {
    const n = Number(m[1])
    if (n > max) max = n
  }
  return 'rId' + (max + 1)
}

/**
 * injectChartsIntoXlsx — take the buffer SheetJS produced and return a NEW xlsx
 * buffer with real chart parts for `charts` anchored on the first worksheet.
 *
 * Returns { buffer, embedded: string[] /* chart ids *\/, skipped: [{id,type,reason}] }.
 * On ANY unexpected package shape it returns the ORIGINAL buffer with every
 * chart reported as skipped — a workbook that opens without charts beats a
 * workbook Excel refuses to open.
 */
export async function injectChartsIntoXlsx(
  buffer: Parameters<typeof JSZip.loadAsync>[0],
  charts: Chart[] | null | undefined,
  sheet: ChartSheet,
): Promise<InjectChartsResult> {
  const list = Array.isArray(charts) ? charts : []
  const skipAll = (reason: string): InjectChartsResult => ({
    buffer,
    embedded: [],
    skipped: list.map((c) => ({ id: c.id, type: c.type, reason })),
  })
  if (!list.length) return { buffer, embedded: [], skipped: [] }

  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(buffer)
  } catch {
    return skipAll('the exported workbook could not be re-opened for chart injection')
  }

  const workbookXml = await zip.file('xl/workbook.xml')?.async('string')
  const wbRelsXml = await zip.file('xl/_rels/workbook.xml.rels')?.async('string')
  const ctPath = '[Content_Types].xml'
  const ctXml = await zip.file(ctPath)?.async('string')
  if (!workbookXml || !wbRelsXml || !ctXml) {
    return skipAll('unexpected workbook structure')
  }
  // A package that ALREADY has drawings is not one we understand; do not fight it.
  if (Object.keys(zip.files).some((f) => f.startsWith('xl/drawings/'))) {
    return skipAll('the workbook already contains drawings')
  }

  const first = firstSheetPart(workbookXml, wbRelsXml)
  if (!first) return skipAll('could not locate the first worksheet')
  const sheetXml = await zip.file(first.path)?.async('string')
  if (!sheetXml) return skipAll('could not read the first worksheet')

  // Build the chart parts.
  const embedded: string[] = []
  const skipped: SkippedChart[] = []
  const anchors: ChartAnchor[] = []
  let n = 0
  for (const chart of list) {
    const support = nativeXlsxSupport(chart?.type)
    if (!support.native) {
      skipped.push({ id: chart.id, type: chart.type, reason: support.note || 'unsupported chart type' })
      continue
    }
    const xml = chartPartXml(chart, sheet, first.name)
    if (!xml) {
      skipped.push({ id: chart.id, type: chart.type, reason: 'its data range could not be resolved' })
      continue
    }
    n++
    const rId = 'rId' + n
    zip.file(`xl/charts/chart${n}.xml`, xml)
    anchors.push({ rId, x: chart.x, y: chart.y, w: chart.w, h: chart.h })
    embedded.push(chart.id)
  }
  if (!n) return { buffer, embedded: [], skipped }

  // drawing1.xml + its rels (chart rIds are local to the drawing part).
  zip.file('xl/drawings/drawing1.xml', drawingXml(anchors))
  zip.file('xl/drawings/_rels/drawing1.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    anchors.map((a, i) =>
      `<Relationship Id="${a.rId}" Type="${REL_CHART}" Target="../charts/chart${i + 1}.xml"/>`
    ).join('') +
    '</Relationships>')

  // Worksheet → drawing relationship (merge into an existing rels part if any).
  const sheetRelsPath = first.path.replace(/([^/]+)$/, '_rels/$1.rels')
  const existingRels = await zip.file(sheetRelsPath)?.async('string')
  let drawingRid: string
  if (existingRels) {
    drawingRid = nextRelId(existingRels)
    const merged = existingRels.replace(
      '</Relationships>',
      `<Relationship Id="${drawingRid}" Type="${REL_DRAWING}" Target="../drawings/drawing1.xml"/></Relationships>`
    )
    if (merged === existingRels) return skipAll('worksheet relationships could not be extended')
    zip.file(sheetRelsPath, merged)
  } else {
    drawingRid = 'rId1'
    zip.file(sheetRelsPath,
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      `<Relationship Id="${drawingRid}" Type="${REL_DRAWING}" Target="../drawings/drawing1.xml"/>` +
      '</Relationships>')
  }

  // <drawing r:id="…"/> on the worksheet.
  const nextSheetXml = insertDrawingElement(sheetXml, drawingRid)
  if (!nextSheetXml) return skipAll('the worksheet XML could not be extended')
  zip.file(first.path, nextSheetXml)

  // Content types for the new parts.
  const overrides =
    `<Override PartName="/xl/drawings/drawing1.xml" ContentType="${CT_DRAWING}"/>` +
    anchors.map((_, i) =>
      `<Override PartName="/xl/charts/chart${i + 1}.xml" ContentType="${CT_CHART}"/>`
    ).join('')
  const nextCt = ctXml.replace('</Types>', overrides + '</Types>')
  if (nextCt === ctXml) return skipAll('content types could not be extended')
  zip.file(ctPath, nextCt)

  const out = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' })
  return { buffer: out, embedded, skipped }
}
