/**
 * src/apps/sheets/PivotLayer.tsx  (WAVE-63 — reactive pivot tables)
 *
 * Floating live-pivot overlay for Sheets, mirroring ChartLayer. Renders every
 * pivot descriptor in `sheet.pivots` as an absolutely-positioned card over the
 * grid, each card holding a LIVE aggregated table (computePivot). Pivots are:
 *   - reactive  — each card memoises its aggregation on pivotValuesSignature
 *                 (a fingerprint of ONLY its source cells + config), so editing
 *                 a source cell re-aggregates exactly the pivots that read it,
 *                 and typing elsewhere does not.
 *   - deletable — × button.
 *
 * SECURITY: every header/label/value that reaches the DOM is rendered as a React
 * text child (escaped) — there is NO dangerouslySetInnerHTML here — so an
 * untrusted source cell like `<script>` or `=HYPERLINK(...)` renders as literal
 * glyphs, never markup or a formula. The descriptor synced/saved is plain data.
 */
import { memo, useMemo, useCallback, useRef, useState, useEffect } from 'react'
import { Trash2, Table2, Pencil, GripVertical } from 'lucide-react'
import {
  getPivots, computePivotModel, pivotPercentColumns, pivotValuesSignature, deletePivot, updatePivot,
  type Pivot, type PivotSheet,
} from './pivot.js'

interface Pos { x: number; y: number }

interface PivotCardProps {
  pivot: Pivot
  sheet: PivotSheet | null | undefined
  onDelete: (id: string) => void
  onEdit: (id: string) => void
  onCommitPos: (id: string, pos: Pos) => void
}

const PivotCard = memo(function PivotCard({ pivot, sheet, onDelete, onEdit, onCommitPos }: PivotCardProps) {
  const signature = pivotValuesSignature(pivot, sheet)
  const model = useMemo(
    () => computePivotModel(pivot, sheet),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature]
  )
  const result = model?.table || null
  // WAVE-64: a "% of total/row/column" column holds numbers on a 0–100 scale —
  // rendering a bare 33.33 next to raw sums would read as a value, not a share.
  const pctCols = useMemo(() => pivotPercentColumns(model), [model])

  // Draggable position (like charts) so multiple pivots don't pile up at origin
  // and can be moved off the source data. Commits on pointer-up only.
  const [pos, setPos] = useState<Pos>({ x: pivot.x, y: pivot.y })
  const dragRef = useRef<boolean | null>(null)
  const rafRef = useRef(0)
  useEffect(() => {
    if (!dragRef.current) setPos({ x: pivot.x, y: pivot.y })
  }, [pivot.x, pivot.y])

  const startDrag = useCallback((e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation()
    const startX = e.clientX, startY = e.clientY
    const base = { x: pivot.x, y: pivot.y }
    dragRef.current = true
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY
      cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(() => setPos({ x: Math.max(0, base.x + dx), y: Math.max(0, base.y + dy) }))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      cancelAnimationFrame(rafRef.current)
      dragRef.current = null
      setPos((g) => { onCommitPos(pivot.id, g); return g })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [pivot.id, pivot.x, pivot.y, onCommitPos])

  return (
    <div
      className="absolute rounded-lg overflow-hidden shadow-e2 bg-white"
      style={{
        left: pos.x, top: pos.y, maxWidth: 520, maxHeight: 360,
        border: '1px solid #e2e8f0', zIndex: 15, pointerEvents: 'auto',
      }}
      data-pivot-id={pivot.id}
    >
      {/* Header (drag handle) */}
      <div
        className="flex items-center justify-between px-2 select-none"
        style={{ height: 26, background: '#f8fafc', borderBottom: '1px solid #e2e8f0', cursor: 'move' }}
        onPointerDown={startDrag}
      >
        <span className="flex items-center gap-1 text-[10px] text-slate-500 truncate">
          <GripVertical size={11} aria-hidden />
          <Table2 size={11} aria-hidden />
          <span className="truncate max-w-[280px]">{pivot.title || 'Pivot table'}</span>
        </span>
        <span className="flex items-center gap-0.5">
          <button
            type="button" title="Edit pivot" aria-label="Edit pivot"
            className="p-1 rounded hover:bg-slate-200 text-slate-500"
            onClick={(e) => { e.stopPropagation(); onEdit(pivot.id) }}
          >
            <Pencil size={12} />
          </button>
          <button
            type="button" title="Delete pivot" aria-label="Delete pivot"
            className="p-1 rounded hover:bg-red-100 text-slate-500 hover:text-red-600"
            onClick={(e) => { e.stopPropagation(); onDelete(pivot.id) }}
          >
            <Trash2 size={12} />
          </button>
        </span>
      </div>

      {/* Live table */}
      <div style={{ overflow: 'auto', maxHeight: 330 }}>
        {result ? (
          <table className="text-[11px] w-full border-collapse">
            <thead>
              <tr>
                {result[0].map((h, i) => (
                  <th
                    key={i}
                    className="px-2 py-1 border border-slate-200 bg-slate-50 text-slate-600 font-semibold text-left whitespace-nowrap"
                  >
                    {String(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.slice(1).map((row, ri) => {
                const isTotal = ri === result.length - 2
                return (
                  <tr key={ri} className={isTotal ? 'font-semibold bg-slate-50' : ri % 2 ? 'bg-slate-50/40' : ''}>
                    {row.map((cell, ci) => (
                      <td
                        key={ci}
                        className="px-2 py-0.5 border border-slate-200 text-slate-700 whitespace-nowrap"
                      >
                        {typeof cell === 'number'
                          ? cell.toLocaleString(undefined, { maximumFractionDigits: 4 }) + (pctCols.has(ci) ? '%' : '')
                          : String(cell)}
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : (
          <p className="p-3 text-[11px] text-slate-400">
            No data — check the source range and that Row/Value fields match the header names.
          </p>
        )}
      </div>
    </div>
  )
})

export interface PivotLayerProps {
  data: PivotSheet[]
  onChange: (data: PivotSheet[]) => void
  onEdit: (id: string) => void
}

/**
 * PivotLayer — the overlay. Positioned absolutely inside the workbook wrapper
 * (position: relative). pointer-events:none on the container so grid interaction
 * passes through; each card re-enables pointer-events for itself. Cards stack at
 * a fixed offset (kept simple — pivots are read surfaces, not draggable objects
 * like charts).
 */
export default function PivotLayer({ data, onChange, onEdit }: PivotLayerProps) {
  const sheet = data?.[0]
  const pivots = useMemo(() => getPivots(data), [data])

  const handleDelete = useCallback((id: string) => {
    onChange(deletePivot(data, id))
  }, [data, onChange])

  const handleCommitPos = useCallback((id: string, pos: Pos) => {
    onChange(updatePivot(data, id, { x: pos.x, y: pos.y }))
  }, [data, onChange])

  if (!pivots.length) return null

  return (
    <div className="absolute inset-0" style={{ pointerEvents: 'none', overflow: 'hidden' }}>
      {pivots.map((pivot) => (
        <PivotCard
          key={pivot.id}
          pivot={pivot}
          sheet={sheet}
          onDelete={handleDelete}
          onEdit={onEdit}
          onCommitPos={handleCommitPos}
        />
      ))}
    </div>
  )
}
