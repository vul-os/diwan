/**
 * src/apps/sheets/ChartWizard.tsx  (WAVE-54, rewritten)
 *
 * Chart editor dialog for Sheets. Produces a PLAIN-DATA chart descriptor
 * (see charts.js) that is stored on the sheet as `sheet.charts`, CRDT-synced,
 * and rendered live by ChartLayer/ChartSvg as inline SVG.
 *
 * This replaces the previous version, which emitted a FortuneSheet-native
 * `sheet.chart` descriptor — but @fortune-sheet/react (OSS) has no chart
 * renderer, so that descriptor was inert dead data. We now own the render.
 *
 * Insert mode  (chart == null): builds a new chart, defaulting the range to the
 *   current grid selection.
 * Edit mode    (chart set):      pre-fills from an existing chart, patches it.
 *
 * SECURITY: title / axis labels are captured as plain form strings and stored as
 * plain data; they are only ever rendered as SVG <text> (escaped). No formula or
 * HTML is evaluated here.
 */
import { useRef, useState } from 'react'
import { X, BarChart2 } from 'lucide-react'
import { Button, IconButton, useDialogA11y } from '../../components/ui'
import {
  CHART_TYPE_GROUPS, makeChart, insertChart, updateChart, stackModeOf,
  HISTOGRAM_BINS_MIN, HISTOGRAM_BINS_MAX, HISTOGRAM_BINS_DEFAULT,
  type Chart, type ChartSheet,
} from './charts.js'

interface SelectionRect { r0: number; r1: number; c0: number; c1: number }

export interface ChartWizardProps {
  data: ChartSheet[]
  chart?: Chart | null
  selectionRect?: SelectionRect | null
  onClose: () => void
  onChange: (data: ChartSheet[]) => void
}

// Per-type guidance shown under the picker. A chart type that reads its range in
// a non-obvious way (scatter/bubble/histogram) MUST say so, or the user just
// sees a wrong-looking chart and no explanation.
const TYPE_HINT: Record<string, string> = {
  scatter:   'Scatter plots the 1st column as X and the 2nd as Y. Turn off “First column = labels”.',
  bubble:    'Bubble plots three numeric columns as X, Y and bubble size. Turn off “First column = labels”.',
  histogram: 'Histogram bins the FIRST numeric column into buckets and plots how often values fall in each.',
  combo:     'Combo draws the 1st series as columns and every other series as a line.',
  'column-stacked': 'Series stack on top of each other; the axis shows the category total.',
  'bar-stacked':    'Series stack end to end; the axis shows the category total.',
  'column-100':     'Each category is normalised to 100% — compares composition, not magnitude.',
  'bar-100':        'Each category is normalised to 100% — compares composition, not magnitude.',
  donut:     'Donut plots the first series as a share of the total, with the total in the middle.',
}

/**
 * selectionToRange — turn the editor's tracked selection rect (0-indexed
 * inclusive {r0,r1,c0,c1}) into A1 text. Returns '' when no usable selection.
 */
export function selectionToRange(sel: SelectionRect | null | undefined): string {
  if (!sel) return ''
  const { r0, r1, c0, c1 } = sel
  if ([r0, r1, c0, c1].some((n) => typeof n !== 'number' || n < 0)) return ''
  const a1 = (r: number, c: number) => colName(c) + (r + 1)
  return a1(Math.min(r0, r1), Math.min(c0, c1)) + ':' + a1(Math.max(r0, r1), Math.max(c0, c1))
}

function colName(c: number): string {
  let s = ''
  let n = c
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1 } while (n >= 0)
  return s
}

export default function ChartWizard({ data, chart, selectionRect, onClose, onChange }: ChartWizardProps) {
  const editing = !!chart
  const [chartType, setChartType] = useState(chart?.type || 'column')
  const [range,     setRange]     = useState(chart?.range || selectionToRange(selectionRect))
  const [title,     setTitle]     = useState(chart?.title || '')
  const [xLabel,    setXLabel]    = useState(chart?.options?.xAxisLabel || '')
  const [yLabel,    setYLabel]    = useState(chart?.options?.yAxisLabel || '')
  const [y2Label,   setY2Label]   = useState(chart?.options?.y2AxisLabel || '')
  const [legend,    setLegend]    = useState(chart?.options?.legend !== false)
  const [headerRow, setHeaderRow] = useState(chart?.options?.headerRow !== false)
  const [headerCol, setHeaderCol] = useState(chart?.options?.headerCol !== false)
  const [secondary, setSecondary] = useState(chart?.options?.secondaryAxis === true)
  const [bins,      setBins]      = useState<number | string>(chart?.options?.bins || HISTOGRAM_BINS_DEFAULT)
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogA11y(dialogRef, onClose)

  const isCombo     = chartType === 'combo'
  const isHistogram = chartType === 'histogram'
  const isStacked   = stackModeOf(chartType) !== 'none'

  function useSelection() {
    const r = selectionToRange(selectionRect)
    if (r) setRange(r)
  }

  // Picking COMBO turns the secondary axis on: a combo whose line series shares
  // the columns' scale is usually unreadable, which is the whole reason to reach
  // for a combo. Only on the TRANSITION into combo, and never against an existing
  // chart's saved choice — otherwise re-clicking the already-selected Combo tile
  // would silently re-check a box the user just cleared.
  function pickType(value: string) {
    if (value === chartType) return
    if (value === 'combo' && chart?.options?.secondaryAxis === undefined) setSecondary(true)
    setChartType(value)
  }

  function handleSubmit() {
    const built = makeChart({
      ...(chart || {}),
      type: chartType,
      range,
      title,
      options: {
        xAxisLabel: xLabel, yAxisLabel: yLabel, y2AxisLabel: y2Label,
        legend, headerRow, headerCol,
        secondaryAxis: isCombo ? secondary : false,
        bins: Number(bins) || HISTOGRAM_BINS_DEFAULT,
      },
    })
    const next = editing && chart
      ? updateChart(data, chart.id, built)
      : insertChart(data, built)
    onChange(next)
    onClose()
  }

  const inputCls = 'w-full rounded border border-line bg-bg px-2 py-1.5 text-xs text-ink focus:outline-none focus:border-line-strong'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={editing ? 'Edit chart' : 'Insert chart'}
        className="bg-paper rounded-xl border border-line shadow-e3 w-[480px] max-h-[85vh] flex flex-col overflow-hidden animate-scale-in"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-line">
          <span className="text-sm font-semibold text-ink flex items-center gap-2">
            <BarChart2 size={14} className="text-accent" aria-hidden /> {editing ? 'Edit chart' : 'Insert chart'}
          </span>
          <IconButton size="sm" title="Close" onClick={onClose}><X size={13} /></IconButton>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 text-xs">
          <div className="space-y-2">
            <p className="text-ink-muted font-medium">Chart type</p>
            <div role="radiogroup" aria-label="Chart type" className="space-y-2">
              {CHART_TYPE_GROUPS.map((g) => (
                <div key={g.group} className="space-y-1">
                  <p className="text-2xs uppercase tracking-eyebrow text-ink-faint">{g.group}</p>
                  <div className="grid grid-cols-4 gap-1.5">
                    {g.types.map((ct) => (
                      <button
                        key={ct.value}
                        type="button"
                        role="radio"
                        aria-checked={chartType === ct.value}
                        onClick={() => pickType(ct.value)}
                        className={[
                          'flex flex-col items-center gap-1 py-2 px-1 rounded-lg border transition-colors duration-fast',
                          'text-[10px] leading-tight text-center',
                          'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                          chartType === ct.value
                            ? 'border-accent bg-accent-tint text-accent font-semibold'
                            : 'border-line text-ink-muted hover:border-line-strong hover:text-ink',
                        ].join(' ')}
                      >
                        <span className="text-base leading-none" aria-hidden>{ct.icon}</span>
                        {ct.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {TYPE_HINT[chartType] && (
              <p className="text-2xs text-ink-faint" role="note">{TYPE_HINT[chartType]}</p>
            )}
          </div>

          <div className="space-y-1">
            <label className="block text-ink-muted font-medium" htmlFor="chart-range">Data range</label>
            <div className="flex gap-1.5">
              <input
                id="chart-range"
                value={range}
                onChange={(e) => setRange(e.target.value)}
                className={inputCls}
                placeholder="e.g. A1:D10"
              />
              <Button variant="secondary" size="sm" onClick={useSelection} title="Use current selection">Use selection</Button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex items-center gap-2 text-ink-muted">
              <input type="checkbox" checked={headerRow} onChange={(e) => setHeaderRow(e.target.checked)} />
              First row = series names
            </label>
            <label className="flex items-center gap-2 text-ink-muted">
              <input type="checkbox" checked={headerCol} onChange={(e) => setHeaderCol(e.target.checked)} />
              First column = labels
            </label>
          </div>

          <div className="space-y-1">
            <label className="block text-ink-muted font-medium" htmlFor="chart-title">Chart title</label>
            <input id="chart-title" value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} placeholder="Optional title" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="block text-ink-muted font-medium" htmlFor="chart-x">X-axis label</label>
              <input id="chart-x" value={xLabel} onChange={(e) => setXLabel(e.target.value)} className={inputCls}
                     placeholder={isHistogram ? 'Value' : 'X axis'} />
            </div>
            <div className="space-y-1">
              <label className="block text-ink-muted font-medium" htmlFor="chart-y">Y-axis label</label>
              <input id="chart-y" value={yLabel} onChange={(e) => setYLabel(e.target.value)} className={inputCls}
                     placeholder={isHistogram ? 'Frequency' : 'Y axis'} />
            </div>
          </div>

          {/* Histogram: bucket count. */}
          {isHistogram && (
            <div className="space-y-1">
              <label className="block text-ink-muted font-medium" htmlFor="chart-bins">
                Buckets <span className="text-ink-faint font-normal">({HISTOGRAM_BINS_MIN}–{HISTOGRAM_BINS_MAX})</span>
              </label>
              <input
                id="chart-bins" type="number" inputMode="numeric"
                min={HISTOGRAM_BINS_MIN} max={HISTOGRAM_BINS_MAX}
                value={bins}
                onChange={(e) => setBins(e.target.value)}
                className={inputCls}
              />
            </div>
          )}

          {/* Combo: secondary axis for the line series. */}
          {isCombo && (
            <div className="space-y-2 rounded-lg border border-line p-2.5">
              <label className="flex items-center gap-2 text-ink-muted">
                <input type="checkbox" checked={secondary} onChange={(e) => setSecondary(e.target.checked)} />
                Plot line series on a secondary (right) axis
              </label>
              {secondary && (
                <div className="space-y-1">
                  <label className="block text-ink-muted font-medium" htmlFor="chart-y2">Secondary axis label</label>
                  <input id="chart-y2" value={y2Label} onChange={(e) => setY2Label(e.target.value)} className={inputCls} placeholder="e.g. Margin %" />
                </div>
              )}
            </div>
          )}

          {isStacked && (
            <p className="text-2xs text-ink-faint" role="note">
              Negative values stack below the zero line — they are never dropped.
            </p>
          )}

          <label className="flex items-center gap-2 text-ink-muted">
            <input type="checkbox" checked={legend} onChange={(e) => setLegend(e.target.checked)} />
            Show legend
          </label>
        </div>

        <div className="flex items-center justify-between px-4 py-3 border-t border-line gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={handleSubmit}>{editing ? 'Save chart' : 'Insert chart'}</Button>
        </div>
      </div>
    </div>
  )
}
