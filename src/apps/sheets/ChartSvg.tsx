/**
 * src/apps/sheets/ChartSvg.tsx  (WAVE-54, extended WAVE-64)
 *
 * Self-contained SVG chart renderer — NO charting library.
 *
 * Renders a chart descriptor + extracted plain data as inline SVG. Every string
 * that reaches the DOM is an SVG <text> child (React escapes it) — there is no
 * dangerouslySetInnerHTML anywhere in this file, so a cell value like
 * `<script>alert(1)</script>` or `=HYPERLINK("javascript:…")` renders as literal
 * text glyphs and can never become markup or a formula.
 *
 * Supported (WAVE-64):
 *   column · bar · stacked column/bar · 100% stacked column/bar
 *   line · area · combo (columns + lines, optional SECONDARY axis)
 *   pie · donut
 *   scatter · bubble · histogram (binned frequency)
 *
 * Every geometry number below is derived from a makeChart-clamped descriptor and
 * a bounded extraction, so a hostile descriptor cannot drive NaN layout: the
 * renderer additionally guards each divisor (nCat, maxV, span) so a degenerate
 * range still produces valid SVG rather than `NaN` path data.
 */
import { useMemo } from 'react'
import {
  extractChartData, chartAccessibleSummary, CHART_TYPES, CHART_PALETTE,
  stackModeOf, isHorizontalBar, histogramBins, histogramValues,
  type Chart, type ChartSheet, type ExtractedChartData, type ChartSeries,
} from './charts.js'

interface Plot { x: number; y: number; w: number; h: number }

export interface ChartSvgProps {
  chart: Chart
  sheet?: ChartSheet | null
  width?: number
  height?: number
  extracted?: ExtractedChartData | null
  titleId?: string
  descId?: string
}

const PAD = { top: 34, right: 16, bottom: 40, left: 44 }
// Chart chrome (axes / gridlines / labels) rides the design tokens so charts
// read correctly in light AND dark. Series colours stay data-driven (s.color).
const AXIS = 'var(--ink-faint)'
const GRID = 'var(--line-strong)'
const INK = 'var(--ink-muted)'
const SECONDARY_PAD = 42   // extra right padding when a secondary axis is drawn

function niceMax(v: number): number {
  if (v <= 0) return 1
  const mag = Math.pow(10, Math.floor(Math.log10(v)))
  const norm = v / mag
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10
  return step * mag
}

/** Types that draw their own legend (pie/donut) or need none (histogram). */
const NO_BOTTOM_LEGEND = new Set(['pie', 'donut', 'histogram'])

/**
 * ChartSvg — the SVG for a chart, given a descriptor + the sheet (or already-
 * extracted data). Split out so both the live overlay and tests can share it.
 */
export function ChartSvg({ chart, sheet, width, height, extracted: extractedProp, titleId, descId }: ChartSvgProps) {
  const extracted = useMemo(
    () => extractedProp || extractChartData(chart, sheet),
    [extractedProp, chart, sheet]
  )
  const W = Math.max(160, width || chart.w || 480)
  const H = Math.max(120, height || chart.h || 300)
  const summary = chartAccessibleSummary(chart, extracted)
  const kindLabel = CHART_TYPES.find((t) => t.value === chart.type)?.label || chart.type

  const showLegend = chart.options?.legend !== false && extracted.series.length > 0
  const bottomLegend = showLegend && !NO_BOTTOM_LEGEND.has(chart.type)
  const legendH = bottomLegend ? 18 : 0

  // Combo with a secondary axis needs room on the right for its tick labels.
  const secondary = chart.type === 'combo' && chart.options?.secondaryAxis === true &&
    extracted.series.length > 1
  const rightPad = PAD.right + (secondary ? SECONDARY_PAD : 0)

  const plot: Plot = {
    x: PAD.left,
    y: PAD.top,
    w: Math.max(20, W - PAD.left - rightPad),
    h: Math.max(20, H - PAD.top - PAD.bottom - legendH),
  }

  let body = null
  if (extracted.empty) {
    body = (
      <text x={W / 2} y={H / 2} textAnchor="middle" fontSize="12" fill={AXIS}>
        No data in range
      </text>
    )
  } else if (chart.type === 'pie' || chart.type === 'donut') {
    body = <Pie chart={chart} extracted={extracted} W={W} H={H} legendH={legendH}
                donut={chart.type === 'donut'} showLegend={showLegend} />
  } else if (chart.type === 'scatter' || chart.type === 'bubble') {
    // WAVE-63: X/Y scatter (2 series = x,y) and bubble (3rd series = size).
    body = <ScatterChart chart={chart} extracted={extracted} plot={plot} bubble={chart.type === 'bubble'} />
  } else if (chart.type === 'histogram') {
    // WAVE-64: bin ONE numeric series into a frequency distribution.
    body = <Histogram chart={chart} extracted={extracted} plot={plot} W={W} H={H} legendH={legendH} />
  } else if (stackModeOf(chart.type) !== 'none') {
    // WAVE-64: stacked / 100%-stacked column + bar.
    body = <StackedCartesian chart={chart} extracted={extracted} plot={plot} W={W} H={H} legendH={legendH} />
  } else {
    // column/bar/line/area/combo share the grouped cartesian renderer.
    body = (
      <CartesianChart chart={chart} extracted={extracted} plot={plot} W={W} H={H}
                      legendH={legendH} secondary={secondary} />
    )
  }

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-labelledby={titleId ? `${titleId} ${descId}` : undefined}
      aria-label={titleId ? undefined : summary}
      style={{ display: 'block', background: 'var(--bg-elev-1)' }}
    >
      {titleId && <title id={titleId}>{chart.title || `${kindLabel} chart`}</title>}
      {descId && <desc id={descId}>{summary}</desc>}
      {/* Chart title — SVG <text>, escaped by React. NEVER innerHTML. */}
      {chart.title ? (
        <text x={W / 2} y={20} textAnchor="middle" fontSize="13" fontWeight="600" fill={INK}>
          {chart.title}
        </text>
      ) : null}
      {body}
      {!extracted.empty && bottomLegend && (
        <Legend chart={chart} series={extracted.series} y={H - legendH + 2} W={W} secondary={secondary} />
      )}
    </svg>
  )
}

interface LegendProps { chart: Chart; series: ChartSeries[]; y: number; W: number; secondary: boolean }

/**
 * Legend — one centred row of chips. For a COMBO chart with a secondary axis the
 * chips carry an axis marker (L/R) so the reader knows which scale a series is
 * measured against; a legend that hides that is actively misleading.
 */
function Legend({ chart, series, y, W, secondary }: LegendProps) {
  const chips = series.slice(0, 8)
  const isCombo = chart?.type === 'combo'
  const gap = Math.min(120, (W - 20) / Math.max(1, chips.length))
  const totalW = gap * chips.length
  const startX = Math.max(10, (W - totalW) / 2)
  return (
    <g data-testid="chart-legend">
      {chips.map((s, i) => {
        const axisTag = secondary ? (i === 0 ? ' (L)' : ' (R)') : ''
        const isLine = isCombo && i > 0
        const name = s.name.length > 13 ? s.name.slice(0, 12) + '…' : s.name
        return (
          <g key={i} transform={`translate(${startX + i * gap}, ${y})`}>
            {isLine ? (
              // Line series get a line swatch, not a block — the mark in the
              // legend must match the mark on the plot.
              <g>
                <line x1="0" y1="5" x2="10" y2="5" stroke={s.color} strokeWidth="2" />
                <circle cx="5" cy="5" r="2.2" fill={s.color} />
              </g>
            ) : (
              <rect width="10" height="10" rx="2" fill={s.color} />
            )}
            <text x="14" y="9" fontSize="10" fill={INK}>
              {name}{axisTag}
            </text>
          </g>
        )
      })}
    </g>
  )
}

interface AxisFrameProps {
  chart: Chart; plot: Plot; W: number; H: number; legendH: number
  yLabel?: string; xLabel?: string; secondary?: boolean
}

/** Shared axis frame (left + bottom rules and the optional axis titles). */
function AxisFrame({ chart, plot, W, H, legendH, yLabel, xLabel, secondary }: AxisFrameProps) {
  const y2 = chart.options?.y2AxisLabel
  return (
    <g>
      <line x1={plot.x} y1={plot.y} x2={plot.x} y2={plot.y + plot.h} stroke={AXIS} strokeWidth="1" />
      <line x1={plot.x} y1={plot.y + plot.h} x2={plot.x + plot.w} y2={plot.y + plot.h} stroke={AXIS} strokeWidth="1" />
      {secondary && (
        <line x1={plot.x + plot.w} y1={plot.y} x2={plot.x + plot.w} y2={plot.y + plot.h}
              stroke={AXIS} strokeWidth="1" />
      )}
      {yLabel ? (
        <text x={10} y={plot.y + plot.h / 2} fontSize="9" fill={AXIS}
              transform={`rotate(-90 10 ${plot.y + plot.h / 2})`} textAnchor="middle">
          {truncate(yLabel, 24)}
        </text>
      ) : null}
      {secondary && y2 ? (
        <text x={W - 6} y={plot.y + plot.h / 2} fontSize="9" fill={AXIS}
              transform={`rotate(90 ${W - 6} ${plot.y + plot.h / 2})`} textAnchor="middle">
          {truncate(y2, 24)}
        </text>
      ) : null}
      {xLabel ? (
        <text x={plot.x + plot.w / 2} y={H - legendH - 2} fontSize="9" fill={AXIS} textAnchor="middle">
          {truncate(xLabel, 30)}
        </text>
      ) : null}
    </g>
  )
}

interface ValueGridProps { plot: Plot; maxV: number; minV?: number; ticks?: number; suffix?: string }

/** Value-axis gridlines + tick labels (vertical value axis, i.e. columns/lines). */
function ValueGrid({ plot, maxV, minV = 0, ticks = 4, suffix = '' }: ValueGridProps) {
  const span = maxV - minV || 1
  const out = []
  for (let t = 0; t <= ticks; t++) {
    const frac = t / ticks
    const val = minV + span * frac
    const y = plot.y + plot.h - plot.h * frac
    out.push(
      <g key={t}>
        <line x1={plot.x} y1={y} x2={plot.x + plot.w} y2={y}
              stroke={val === 0 && minV < 0 ? AXIS : GRID} strokeWidth="1" />
        <text x={plot.x - 6} y={y + 3} textAnchor="end" fontSize="9" fill={AXIS}>
          {formatTick(val)}{suffix}
        </text>
      </g>
    )
  }
  return <g>{out}</g>
}

/** Value-axis gridlines for the HORIZONTAL bar family (value runs along x). */
function ValueGridX({ plot, maxV, minV = 0, ticks = 4, suffix = '' }: ValueGridProps) {
  const span = maxV - minV || 1
  const out = []
  for (let t = 0; t <= ticks; t++) {
    const frac = t / ticks
    const val = minV + span * frac
    const x = plot.x + plot.w * frac
    out.push(
      <g key={t}>
        <line x1={x} y1={plot.y} x2={x} y2={plot.y + plot.h}
              stroke={val === 0 && minV < 0 ? AXIS : GRID} strokeWidth="1" />
        <text x={x} y={plot.y + plot.h + 12} textAnchor="middle" fontSize="9" fill={AXIS}>
          {formatTick(val)}{suffix}
        </text>
      </g>
    )
  }
  return <g>{out}</g>
}

interface ChartBodyProps { chart: Chart; extracted: ExtractedChartData; plot: Plot; W: number; H: number; legendH: number; secondary?: boolean }

function CartesianChart({ chart, extracted, plot, W, H, legendH, secondary }: ChartBodyProps) {
  const { categories, series } = extracted
  const isBar = isHorizontalBar(chart.type)   // horizontal
  const isLine = chart.type === 'line'
  const isArea = chart.type === 'area'
  const isCombo = chart.type === 'combo'      // series[0] = columns, series[1..] = lines

  // Grouped (non-stacked): the axis max is the largest single value. With a
  // COMBO secondary axis the line series get their OWN max, so a 0–1 margin
  // series is not flattened onto a 0–10000 revenue scale.
  const barPart = isCombo ? series.slice(0, 1) : series
  const linePart = isCombo ? series.slice(1) : []
  const maxOf = (list: ChartSeries[]) => {
    let m = 0
    for (const s of list) for (const v of s.values) if (v > m) m = v
    return m
  }
  const primaryMax = niceMax(maxOf(secondary ? barPart : series))
  const secondaryMax = secondary ? niceMax(maxOf(linePart)) : primaryMax
  const maxV = primaryMax

  const nCat = Math.max(1, categories.length)
  const shapes: React.ReactNode[] = []

  if (isBar) {
    // Horizontal grouped bars.
    const bandH = plot.h / nCat
    const groupPad = bandH * 0.18
    const barH = (bandH - groupPad * 2) / Math.max(1, series.length)
    categories.forEach((cat, ci) => {
      series.forEach((s, sj) => {
        const v = s.values[ci] || 0
        const len = maxV ? (v / maxV) * plot.w : 0
        const y = plot.y + ci * bandH + groupPad + sj * barH
        shapes.push(
          <rect key={`b-${ci}-${sj}`} x={plot.x} y={y} width={Math.max(0, len)} height={Math.max(1, barH - 1)}
                fill={s.color} rx="1">
            <title>{`${s.name} · ${cat}: ${v}`}</title>
          </rect>
        )
      })
      shapes.push(
        <text key={`bl-${ci}`} x={plot.x - 6} y={plot.y + ci * bandH + bandH / 2 + 3}
              textAnchor="end" fontSize="9" fill={INK}>
          {truncate(cat, 10)}
        </text>
      )
    })
  } else if (isLine || isArea) {
    const stepX = nCat > 1 ? plot.w / (nCat - 1) : plot.w
    series.forEach((s, sj) => {
      const pts = s.values.map((v, ci) => {
        const x = plot.x + (nCat > 1 ? ci * stepX : plot.w / 2)
        const y = plot.y + plot.h - (maxV ? (v / maxV) * plot.h : 0)
        return [x, y]
      })
      if (!pts.length) return
      const line = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0] + ' ' + p[1]).join(' ')
      if (isArea) {
        const area = line +
          ` L ${pts[pts.length - 1][0]} ${plot.y + plot.h}` +
          ` L ${pts[0][0]} ${plot.y + plot.h} Z`
        shapes.push(<path key={`a-${sj}`} d={area} fill={s.color} fillOpacity="0.18" stroke="none" />)
      }
      shapes.push(<path key={`l-${sj}`} d={line} fill="none" stroke={s.color} strokeWidth="2" />)
      pts.forEach((p, ci) => shapes.push(
        <circle key={`p-${sj}-${ci}`} cx={p[0]} cy={p[1]} r="2.5" fill={s.color}>
          <title>{`${s.name} · ${categories[ci]}: ${s.values[ci]}`}</title>
        </circle>
      ))
    })
    // category labels along x
    categories.forEach((cat, ci) => {
      const x = plot.x + (nCat > 1 ? ci * stepX : plot.w / 2)
      shapes.push(
        <text key={`xl-${ci}`} x={x} y={plot.y + plot.h + 12} textAnchor="middle" fontSize="9" fill={INK}>
          {truncate(cat, 8)}
        </text>
      )
    })
  } else {
    // Vertical grouped columns (default) — for COMBO, only series[0] is drawn as
    // columns; the remaining series are overlaid as lines below.
    const bandW = plot.w / nCat
    const groupPad = bandW * 0.18
    const barW = (bandW - groupPad * 2) / Math.max(1, barPart.length)
    categories.forEach((cat, ci) => {
      barPart.forEach((s, sj) => {
        const v = s.values[ci] || 0
        const len = maxV ? (v / maxV) * plot.h : 0
        const x = plot.x + ci * bandW + groupPad + sj * barW
        const y = plot.y + plot.h - len
        shapes.push(
          <rect key={`c-${ci}-${sj}`} x={x} y={y} width={Math.max(1, barW - 1)} height={Math.max(0, len)}
                fill={s.color} rx="1">
            <title>{`${s.name} · ${cat}: ${v}`}</title>
          </rect>
        )
      })
      shapes.push(
        <text key={`cl-${ci}`} x={plot.x + ci * bandW + bandW / 2} y={plot.y + plot.h + 12}
              textAnchor="middle" fontSize="9" fill={INK}>
          {truncate(cat, 8)}
        </text>
      )
    })
    // COMBO line overlay: series[1..] drawn as lines across the band centres,
    // against the SECONDARY scale when the chart asks for one.
    if (isCombo && linePart.length) {
      const cx = (ci: number) => plot.x + ci * bandW + bandW / 2
      const scale = secondary ? secondaryMax : maxV
      linePart.forEach((s, sj) => {
        const pts = s.values.map((v, ci) => [cx(ci), plot.y + plot.h - (scale ? (v / scale) * plot.h : 0)])
        if (!pts.length) return
        const d = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0] + ' ' + p[1]).join(' ')
        shapes.push(<path key={`combo-l-${sj}`} d={d} fill="none" stroke={s.color} strokeWidth="2" />)
        pts.forEach((p, ci) => shapes.push(
          <circle key={`combo-p-${sj}-${ci}`} cx={p[0]} cy={p[1]} r="2.5" fill={s.color}>
            <title>{`${s.name} · ${categories[ci]}: ${s.values[ci]}`}</title>
          </circle>
        ))
      })
    }
  }

  return (
    <g>
      {isBar
        ? <ValueGridX plot={plot} maxV={maxV} />
        : <ValueGrid plot={plot} maxV={maxV} />}
      {/* Secondary (right-hand) value axis for combo. */}
      {secondary && (
        <g data-testid="secondary-axis">
          {[0, 1, 2, 3, 4].map((t) => {
            const frac = t / 4
            const y = plot.y + plot.h - plot.h * frac
            return (
              <text key={t} x={plot.x + plot.w + 6} y={y + 3} textAnchor="start" fontSize="9" fill={AXIS}>
                {formatTick(secondaryMax * frac)}
              </text>
            )
          })}
        </g>
      )}
      <AxisFrame chart={chart} plot={plot} W={W} H={H} legendH={legendH} secondary={secondary}
                 yLabel={chart.options?.yAxisLabel} xLabel={chart.options?.xAxisLabel} />
      {shapes}
    </g>
  )
}

/**
 * StackedCartesian (WAVE-64) — stacked and 100%-stacked column/bar.
 *
 * NEGATIVES ARE NOT SILENTLY DROPPED: positive segments stack away from the zero
 * line and negative ones stack the other way, and the value axis extends below
 * zero when needed (a stacked chart that clamps negatives to 0 lies about the
 * data). In 100% mode each category is normalised by the sum of ABSOLUTE values,
 * so the parts of a mixed-sign category still sum to 100% of its magnitude.
 */
function StackedCartesian({ chart, extracted, plot, W, H, legendH }: ChartBodyProps) {
  const { categories, series } = extracted
  const mode = stackModeOf(chart.type)          // 'stacked' | 'percent'
  const horizontal = isHorizontalBar(chart.type)
  const percent = mode === 'percent'
  const nCat = Math.max(1, categories.length)

  // Per-category positive / negative totals (and the |sum| used by 100% mode).
  const posTot: number[] = [], negTot: number[] = [], absTot: number[] = []
  for (let ci = 0; ci < nCat; ci++) {
    let p = 0, n = 0, a = 0
    for (const s of series) {
      const v = Number(s.values[ci]) || 0
      if (v >= 0) p += v; else n += v
      a += Math.abs(v)
    }
    posTot.push(p); negTot.push(n); absTot.push(a)
  }

  // Value-axis bounds.
  const rawMax = percent ? 100 : Math.max(0, ...posTot)
  const rawMin = percent
    ? (negTot.some((v) => v < 0) ? -100 : 0)
    : Math.min(0, ...negTot)
  const maxV = percent ? rawMax : niceMax(rawMax)
  const minV = percent ? rawMin : (rawMin < 0 ? -niceMax(Math.abs(rawMin)) : 0)
  const span = (maxV - minV) || 1

  // Scale a value (already normalised for percent) to a pixel offset from the
  // axis origin along the value direction.
  const px = (v: number) => (v / span) * (horizontal ? plot.w : plot.h)
  const zero = horizontal
    ? plot.x + px(0 - minV)
    : plot.y + plot.h - px(0 - minV)

  const shapes: React.ReactNode[] = []
  const band = (horizontal ? plot.h : plot.w) / nCat
  const pad = band * 0.16
  const thick = Math.max(1, band - pad * 2)

  categories.forEach((cat, ci) => {
    const denom = percent ? (absTot[ci] || 1) : 1
    let accPos = 0, accNeg = 0
    series.forEach((s, sj) => {
      const raw = Number(s.values[ci]) || 0
      const v = percent ? (raw / denom) * 100 : raw
      if (v === 0) return
      const from = v >= 0 ? accPos : accNeg
      const to = from + v
      if (v >= 0) accPos = to; else accNeg = to
      const lo = Math.min(from, to), hi = Math.max(from, to)
      const label = percent
        ? `${s.name} · ${cat}: ${raw} (${Math.abs(v).toFixed(1)}%)`
        : `${s.name} · ${cat}: ${raw}`
      if (horizontal) {
        const x0 = zero + px(lo), x1 = zero + px(hi)
        shapes.push(
          <rect key={`s-${ci}-${sj}`} x={x0} y={plot.y + ci * band + pad}
                width={Math.max(0.5, x1 - x0)} height={thick} fill={s.color}>
            <title>{label}</title>
          </rect>
        )
      } else {
        const yTop = zero - px(hi), yBot = zero - px(lo)
        shapes.push(
          <rect key={`s-${ci}-${sj}`} x={plot.x + ci * band + pad} y={yTop}
                width={thick} height={Math.max(0.5, yBot - yTop)} fill={s.color}>
            <title>{label}</title>
          </rect>
        )
      }
    })
    // Category label on the category axis.
    if (horizontal) {
      shapes.push(
        <text key={`cl-${ci}`} x={plot.x - 6} y={plot.y + ci * band + band / 2 + 3}
              textAnchor="end" fontSize="9" fill={INK}>{truncate(cat, 10)}</text>
      )
    } else {
      shapes.push(
        <text key={`cl-${ci}`} x={plot.x + ci * band + band / 2} y={plot.y + plot.h + 12}
              textAnchor="middle" fontSize="9" fill={INK}>{truncate(cat, 8)}</text>
      )
    }
  })

  const suffix = percent ? '%' : ''
  return (
    <g data-testid={`stacked-${mode}`}>
      {horizontal
        ? <ValueGridX plot={plot} maxV={maxV} minV={minV} suffix={suffix} />
        : <ValueGrid  plot={plot} maxV={maxV} minV={minV} suffix={suffix} />}
      <AxisFrame chart={chart} plot={plot} W={W} H={H} legendH={legendH}
                 yLabel={chart.options?.yAxisLabel} xLabel={chart.options?.xAxisLabel} />
      {shapes}
    </g>
  )
}

/**
 * Histogram (WAVE-64) — a frequency distribution of ONE numeric series (the
 * first). Bars are adjacent (no group gap) and the y axis counts occurrences,
 * so this reads as a distribution rather than as a category comparison.
 */
function Histogram({ chart, extracted, plot, W, H, legendH }: ChartBodyProps) {
  const { bins, max, total } = histogramBins(histogramValues(extracted), chart.options?.bins)
  if (!bins.length) {
    return (
      <text x={plot.x + plot.w / 2} y={plot.y + plot.h / 2} textAnchor="middle" fontSize="11" fill={AXIS}>
        No numeric values to bin
      </text>
    )
  }
  const maxV = niceMax(max)
  const bandW = plot.w / bins.length
  const color = CHART_PALETTE[0]
  // With many bins, label only every nth boundary so the axis stays legible.
  const every = Math.ceil(bins.length / 8)

  return (
    <g data-testid="histogram">
      <ValueGrid plot={plot} maxV={maxV} />
      <AxisFrame chart={chart} plot={plot} W={W} H={H} legendH={legendH}
                 yLabel={chart.options?.yAxisLabel || 'Frequency'}
                 xLabel={chart.options?.xAxisLabel || extracted.series[0]?.name || ''} />
      {bins.map((b, i) => {
        const h = maxV ? (b.count / maxV) * plot.h : 0
        return (
          <rect key={`h-${i}`} x={plot.x + i * bandW + 0.5} y={plot.y + plot.h - h}
                width={Math.max(1, bandW - 1)} height={Math.max(0, h)} fill={color} fillOpacity="0.85">
            <title>{`${b.label}: ${b.count} of ${total}`}</title>
          </rect>
        )
      })}
      {bins.map((b, i) => (
        i % every === 0 ? (
          <text key={`hl-${i}`} x={plot.x + i * bandW + bandW / 2} y={plot.y + plot.h + 12}
                textAnchor="middle" fontSize="8" fill={INK}>
            {truncate(b.label, 11)}
          </text>
        ) : null
      ))}
    </g>
  )
}

interface PieProps { chart: Chart; extracted: ExtractedChartData; W: number; H: number; legendH: number; donut: boolean; showLegend: boolean }

/**
 * Pie / Donut — plots the FIRST series across categories. The donut variant adds
 * a hole and prints the TOTAL in the middle (the number a donut exists to show).
 */
function Pie({ extracted, W, H, legendH, donut, showLegend }: PieProps) {
  const s = extracted.series[0]
  const values = (s?.values || []).map((v) => (v > 0 ? v : 0))
  const total = values.reduce((a, b) => a + b, 0)
  const cx = W / 2
  const cy = (H - legendH) / 2 + 6
  const r = plotRadius(W, H - legendH)
  const inner = donut ? r * 0.58 : 0
  if (total <= 0) {
    return <text x={cx} y={cy} textAnchor="middle" fontSize="12" fill={AXIS}>No positive values</text>
  }
  let acc = 0
  const slices = values.map((v, i) => {
    const start = (acc / total) * Math.PI * 2
    acc += v
    const end = (acc / total) * Math.PI * 2
    const large = end - start > Math.PI ? 1 : 0
    const p = (radius: number, ang: number): [number, number] => [cx + radius * Math.sin(ang), cy - radius * Math.cos(ang)]
    const [x1, y1] = p(r, start)
    const [x2, y2] = p(r, end)
    let d: string
    if (donut) {
      const [ix2, iy2] = p(inner, end)
      const [ix1, iy1] = p(inner, start)
      d = `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} ` +
          `L ${ix2} ${iy2} A ${inner} ${inner} 0 ${large} 0 ${ix1} ${iy1} Z`
    } else {
      d = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`
    }
    return { d, color: pieColor(i), label: extracted.categories[i], v, pct: ((v / total) * 100).toFixed(0) }
  })
  return (
    <g data-testid={donut ? 'donut' : 'pie'}>
      {slices.map((sl, i) => (
        <path key={i} d={sl.d} fill={sl.color} stroke="#fff" strokeWidth="1">
          <title>{`${sl.label}: ${sl.v} (${sl.pct}%)`}</title>
        </path>
      ))}
      {donut && (
        <g>
          <text x={cx} y={cy - 1} textAnchor="middle" fontSize="14" fontWeight="600" fill={INK}>
            {formatTick(total)}
          </text>
          <text x={cx} y={cy + 12} textAnchor="middle" fontSize="9" fill={AXIS}>
            {truncate(s?.name || 'Total', 14)}
          </text>
        </g>
      )}
      {showLegend && (
        <g data-testid="chart-legend">
          {slices.slice(0, 8).map((sl, i) => (
            <g key={i} transform={`translate(12, ${34 + i * 15})`}>
              <rect width="9" height="9" rx="2" fill={sl.color} />
              <text x="13" y="8" fontSize="9" fill={INK}>
                {truncate(sl.label, 12)} · {sl.pct}%
              </text>
            </g>
          ))}
        </g>
      )}
    </g>
  )
}

interface ScatterChartProps { chart: Chart; extracted: ExtractedChartData; plot: Plot; bubble: boolean }

/**
 * ScatterChart (WAVE-63) — X/Y scatter and bubble. Interprets the extracted
 * series as columns: series[0] = X values, series[1] = Y values, and (bubble)
 * series[2] = point size. Points are aligned by category index. Pure SVG
 * <circle> nodes; the only text is the numeric-tick / point tooltip (escaped).
 */
function ScatterChart({ extracted, plot, bubble }: ScatterChartProps) {
  const { series } = extracted
  const xs = series[0]?.values || []
  const ys = series[1]?.values || []
  const sizes = bubble ? (series[2]?.values || []) : []
  const n = Math.min(xs.length, ys.length)
  if (n === 0 || series.length < 2) {
    return <text x={plot.x + plot.w / 2} y={plot.y + plot.h / 2} textAnchor="middle" fontSize="11" fill={AXIS}>
      Need X and Y columns
    </text>
  }

  let xMin = Infinity, xMax = -Infinity, yMax = 0, sMax = 0
  for (let i = 0; i < n; i++) {
    if (xs[i] < xMin) xMin = xs[i]
    if (xs[i] > xMax) xMax = xs[i]
    if (ys[i] > yMax) yMax = ys[i]
    if (bubble && sizes[i] > sMax) sMax = sizes[i]
  }
  if (!isFinite(xMin)) xMin = 0
  if (!isFinite(xMax) || xMax === xMin) xMax = xMin + 1
  const yTop = niceMax(yMax)
  const xColor = CHART_PALETTE[0]

  const gridLines: React.ReactNode[] = []
  const ticks = 4
  for (let t = 0; t <= ticks; t++) {
    const frac = t / ticks
    const y = plot.y + plot.h - plot.h * frac
    gridLines.push(
      <g key={`gy-${t}`}>
        <line x1={plot.x} y1={y} x2={plot.x + plot.w} y2={y} stroke={GRID} strokeWidth="1" />
        <text x={plot.x - 6} y={y + 3} textAnchor="end" fontSize="9" fill={AXIS}>{formatTick(yTop * frac)}</text>
      </g>
    )
    const x = plot.x + plot.w * frac
    gridLines.push(
      <text key={`gx-${t}`} x={x} y={plot.y + plot.h + 12} textAnchor="middle" fontSize="9" fill={AXIS}>
        {formatTick(xMin + (xMax - xMin) * frac)}
      </text>
    )
  }

  const points: React.ReactNode[] = []
  for (let i = 0; i < n; i++) {
    const px = plot.x + ((xs[i] - xMin) / (xMax - xMin)) * plot.w
    const py = plot.y + plot.h - (yTop ? (ys[i] / yTop) * plot.h : 0)
    const r = bubble && sMax ? 3 + (Math.abs(sizes[i]) / sMax) * 14 : 3.5
    points.push(
      <circle key={`sp-${i}`} cx={px} cy={py} r={r} fill={xColor} fillOpacity={bubble ? 0.5 : 0.85} stroke={xColor}>
        <title>{`(${xs[i]}, ${ys[i]}${bubble ? `, ${sizes[i] ?? 0}` : ''})`}</title>
      </circle>
    )
  }

  return (
    <g>
      {gridLines}
      <line x1={plot.x} y1={plot.y} x2={plot.x} y2={plot.y + plot.h} stroke={AXIS} strokeWidth="1" />
      <line x1={plot.x} y1={plot.y + plot.h} x2={plot.x + plot.w} y2={plot.y + plot.h} stroke={AXIS} strokeWidth="1" />
      {points}
    </g>
  )
}

// ── helpers ──────────────────────────────────────────────────────────────────

function pieColor(i: number): string { return CHART_PALETTE[i % CHART_PALETTE.length] }
function plotRadius(w: number, h: number): number { return Math.max(30, Math.min(w, h) / 2 - 24) }

function formatTick(v: number): string {
  if (Math.abs(v) >= 1000000) return (v / 1000000).toFixed(1) + 'M'
  if (Math.abs(v) >= 1000) return (v / 1000).toFixed(1) + 'k'
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

function truncate(s: unknown, n: number): string {
  const str = String(s ?? '')
  return str.length > n ? str.slice(0, n - 1) + '…' : str
}

export default ChartSvg
