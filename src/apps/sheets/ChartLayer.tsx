/**
 * src/apps/sheets/ChartLayer.tsx  (WAVE-54)
 *
 * Floating chart overlay for Sheets. Renders every chart in `sheet.charts` as an
 * absolutely-positioned card over the grid (like Google Sheets), each card
 * containing a live inline-SVG chart (ChartSvg). Charts are:
 *
 *   - selectable  (click; keyboard-focusable; Enter opens the editor)
 *   - movable     (drag the header; arrow keys nudge when selected)
 *   - resizable   (drag the SE handle)
 *   - deletable   (× button, or Delete/Backspace when focused)
 *
 * REACTIVITY + PERF: each ChartCard memoises its extraction on
 * `chartValuesSignature(chart, sheet)` — a fingerprint of ONLY the cells in that
 * chart's source range plus its own shape config. So typing in an unrelated cell
 * does not recompute the chart, and editing a source cell recomputes exactly the
 * charts that read it. Move/resize is throttled to animation frames and only
 * commits (onChange) on pointer-up, so dragging never spams the CRDT/save path.
 *
 * SECURITY: all on-screen text is SVG <text> (see ChartSvg) — no innerHTML. The
 * descriptor synced/saved is plain data.
 */
import { memo, useMemo, useRef, useState, useCallback, useEffect } from 'react'
import { Pencil, Trash2, GripVertical } from 'lucide-react'
import {
  getCharts, chartValuesSignature, extractChartData, chartAccessibleSummary,
  deleteChart, updateChart,
  type Chart, type ChartSheet,
} from './charts.js'
import { ChartSvg } from './ChartSvg.jsx'

interface Geom { x: number; y: number; w: number; h: number }

interface ChartCardProps {
  chart: Chart
  sheet: ChartSheet | null | undefined
  selected: boolean
  onSelect: (id: string) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onCommitGeom: (id: string, geom: Geom) => void
}

const HEADER_H = 26

const ChartCard = memo(function ChartCard({
  chart, sheet, selected, onSelect, onEdit, onDelete, onCommitGeom,
}: ChartCardProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const [geom, setGeom] = useState<Geom>({ x: chart.x, y: chart.y, w: chart.w, h: chart.h })
  const dragRef = useRef<{ mode: 'move' | 'resize' } | null>(null)
  const rafRef = useRef(0)

  // Keep local geom in sync when the descriptor changes from outside (CRDT peer).
  useEffect(() => {
    if (!dragRef.current) setGeom({ x: chart.x, y: chart.y, w: chart.w, h: chart.h })
  }, [chart.x, chart.y, chart.w, chart.h])

  // Recompute plotted data only when THIS chart's source cells / config change.
  const signature = chartValuesSignature(chart, sheet)
  const extracted = useMemo(
    () => extractChartData(chart, sheet),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature]
  )
  const summary = chartAccessibleSummary(chart, extracted)
  const titleId = `cht-title-${chart.id}`
  const descId  = `cht-desc-${chart.id}`

  const startDrag = useCallback((e: React.PointerEvent, mode: 'move' | 'resize') => {
    e.preventDefault(); e.stopPropagation()
    onSelect(chart.id)
    const startX = e.clientX, startY = e.clientY
    const base = { ...geom }
    dragRef.current = { mode }
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY
      cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(() => {
        setGeom(() => {
          if (mode === 'move') {
            return { ...base, x: Math.max(0, base.x + dx), y: Math.max(0, base.y + dy) }
          }
          return { ...base, w: Math.max(200, base.w + dx), h: Math.max(140, base.h + dy) }
        })
      })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      cancelAnimationFrame(rafRef.current)
      dragRef.current = null
      // Commit once, on release — never mid-drag (keeps CRDT/save quiet).
      setGeom((g) => { onCommitGeom(chart.id, g); return g })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [chart.id, geom, onSelect, onCommitGeom])

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault(); onDelete(chart.id); return
    }
    if (e.key === 'Enter') { e.preventDefault(); onEdit(chart.id); return }
    const nudge = e.shiftKey ? 20 : 4
    let dx = 0, dy = 0
    if (e.key === 'ArrowLeft') dx = -nudge
    else if (e.key === 'ArrowRight') dx = nudge
    else if (e.key === 'ArrowUp') dy = -nudge
    else if (e.key === 'ArrowDown') dy = nudge
    else return
    e.preventDefault()
    setGeom((g) => {
      const next = { ...g, x: Math.max(0, g.x + dx), y: Math.max(0, g.y + dy) }
      onCommitGeom(chart.id, next)
      return next
    })
  }, [chart.id, onDelete, onEdit, onCommitGeom])

  const svgH = geom.h - HEADER_H

  return (
    <div
      ref={cardRef}
      role="group"
      tabIndex={0}
      aria-label={summary}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => { e.stopPropagation(); onSelect(chart.id) }}
      className="absolute rounded-lg overflow-hidden shadow-e2 bg-paper"
      style={{
        left: geom.x, top: geom.y, width: geom.w, height: geom.h,
        border: selected ? '2px solid var(--accent)' : '1px solid var(--line-strong)',
        zIndex: selected ? 30 : 20,
        pointerEvents: 'auto',
      }}
      data-chart-id={chart.id}
    >
      {/* Drag header */}
      <div
        className="flex items-center justify-between px-1.5 select-none"
        style={{ height: HEADER_H, background: 'var(--bg-elev-2)', borderBottom: '1px solid var(--line)', cursor: 'move' }}
        onPointerDown={(e) => startDrag(e, 'move')}
      >
        <span className="flex items-center gap-1 text-[10px] text-ink-faint truncate">
          <GripVertical size={11} aria-hidden />
          <span className="truncate max-w-[180px]">{chart.title || 'Chart'}</span>
        </span>
        <span className="flex items-center gap-0.5">
          <button
            type="button"
            title="Edit chart"
            aria-label="Edit chart"
            className="p-1 rounded hover:bg-bg-hover text-ink-faint hover:text-ink"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onEdit(chart.id) }}
          >
            <Pencil size={12} />
          </button>
          <button
            type="button"
            title="Delete chart"
            aria-label="Delete chart"
            className="p-1 rounded hover:bg-danger-bg text-ink-faint hover:text-danger"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onDelete(chart.id) }}
          >
            <Trash2 size={12} />
          </button>
        </span>
      </div>

      {/* Live SVG chart */}
      <div style={{ width: geom.w, height: svgH, overflow: 'hidden' }}>
        <ChartSvg
          chart={chart}
          sheet={sheet}
          extracted={extracted}
          width={geom.w}
          height={svgH}
          titleId={titleId}
          descId={descId}
        />
      </div>

      {/* Resize handle (SE) */}
      {selected && (
        <div
          role="separator"
          aria-label="Resize chart"
          onPointerDown={(e) => startDrag(e, 'resize')}
          className="absolute"
          style={{
            right: 0, bottom: 0, width: 14, height: 14, cursor: 'nwse-resize',
            background: 'linear-gradient(135deg, transparent 50%, var(--line-emphasis) 50%)',
          }}
        />
      )}
    </div>
  )
})

export interface ChartLayerProps {
  data: ChartSheet[]
  onChange: (data: ChartSheet[]) => void
  selectedId?: string | null
  onSelect: (id: string) => void
  onEdit: (id: string) => void
}

/**
 * ChartLayer — the overlay. Positioned absolutely inside the workbook wrapper
 * (which is `position: relative`). pointer-events:none on the container so grid
 * interaction passes through; each card re-enables pointer-events for itself.
 */
export default function ChartLayer({ data, onChange, selectedId, onSelect, onEdit }: ChartLayerProps) {
  const sheet = data?.[0]
  const charts = useMemo(() => getCharts(data), [data])

  const handleDelete = useCallback((id: string) => {
    onChange(deleteChart(data, id))
  }, [data, onChange])

  const handleCommitGeom = useCallback((id: string, geom: Geom) => {
    onChange(updateChart(data, id, { x: geom.x, y: geom.y, w: geom.w, h: geom.h }))
  }, [data, onChange])

  if (!charts.length) return null

  return (
    <div className="absolute inset-0" style={{ pointerEvents: 'none', overflow: 'hidden' }}>
      {charts.map((chart) => (
        <ChartCard
          key={chart.id}
          chart={chart}
          sheet={sheet}
          selected={selectedId === chart.id}
          onSelect={onSelect}
          onEdit={onEdit}
          onDelete={handleDelete}
          onCommitGeom={handleCommitGeom}
        />
      ))}
    </div>
  )
}
