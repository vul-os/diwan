/**
 * src/apps/sheets/PivotPanel.tsx  (WAVE-63 — reactive pivot; WAVE-64 — depth)
 *
 * Pivot table configuration side panel. Instead of inserting a STATIC snapshot
 * into a new sheet (which went stale the moment a source cell changed), it now
 * builds a PIVOT DESCRIPTOR (plain structured data) that the PivotLayer renders
 * LIVE — re-aggregating from its source range whenever those cells change, like
 * the WAVE-54 charts. The descriptor is validated/clamped through makePivot at
 * every entry point (and at the CRDT ingress in SheetsEditor).
 *
 * WAVE-64 adds the depth Google Sheets has and we lacked: MULTIPLE value fields
 * (each with its own aggregation and its own "% of total / row / column" display
 * mode) and DATE GROUPING of the row/column field into day/month/quarter/year
 * buckets.
 *
 * Props:
 *   data        {Sheet[]}  — current workbook sheets
 *   pivot       {object?}  — existing descriptor when editing (null = insert)
 *   selectionRect {object?}— {r0,r1,c0,c1} to seed the source range
 *   onClose     {fn}       — close the panel
 *   onInsert    {fn(Sheet[])} — commit workbook data with the pivot upserted
 */
import { useState, useMemo, useEffect } from 'react'
import { X, RefreshCw, Table2, Plus, Trash2 } from 'lucide-react'
import { Button, IconButton } from '../../components/ui'
import {
  makePivot, insertPivot, updatePivot, computePivotModel, pivotHeaders, pivotToSheet,
  PIVOT_AGGS, PIVOT_DISPLAYS, PIVOT_DISPLAY_LABEL, PIVOT_GROUPINGS, PIVOT_GROUPING_LABEL,
  type Pivot, type PivotSheet, type PivotValueSpec, type PivotAgg, type PivotDisplay, type PivotGrouping,
} from './pivot.js'

const MAX_VALUES = 8

interface SelectionRect { r0: number; r1: number; c0: number; c1: number }

export interface PivotPanelProps {
  data: PivotSheet[]
  pivot?: Pivot | null
  selectionRect?: SelectionRect | null
  onClose: () => void
  onInsert: (data: PivotSheet[]) => void
  onInsertStatic?: (data: PivotSheet[]) => void
}

// Turn a 0-indexed selection rect into an A1 range string.
function colToLetter(idx: number): string {
  let s = ''
  let n = idx + 1
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26) }
  return s
}
function rectToA1(rect: SelectionRect | null | undefined): string {
  if (!rect) return ''
  const { r0, r1, c0, c1 } = rect
  return `${colToLetter(c0)}${r0 + 1}:${colToLetter(c1)}${r1 + 1}`
}

export default function PivotPanel({ data, pivot: editPivot, selectionRect, onClose, onInsert, onInsertStatic }: PivotPanelProps) {
  const activeSheet = data?.[0]
  const isEditing = !!editPivot

  // Seed the source range: existing pivot → its range; else the selection; else
  // a bounded default over the used area of the sheet.
  const initialRange = useMemo(() => {
    if (editPivot?.range) return editPivot.range
    const sel = rectToA1(selectionRect)
    if (sel) return sel
    let maxR = 0, maxC = 0
    for (const { r, c } of activeSheet?.celldata || []) { if (r > maxR) maxR = r; if (c > maxC) maxC = c }
    return maxR || maxC ? `A1:${colToLetter(maxC)}${maxR + 1}` : 'A1:C10'
  }, [editPivot, selectionRect, activeSheet])

  const [range, setRange] = useState(initialRange)
  const [rowField, setRowField] = useState(editPivot?.rowField || '')
  const [colField, setColField] = useState(editPivot?.colField || '')
  const [rowGroup, setRowGroup] = useState<PivotGrouping>(editPivot?.rowGroup || 'none')
  const [colGroup, setColGroup] = useState<PivotGrouping>(editPivot?.colGroup || 'none')
  const [values, setValues] = useState<PivotValueSpec[]>(
    editPivot?.values?.length
      ? editPivot.values.map((v) => ({ ...v }))
      : editPivot?.valueField
        ? [{ field: editPivot.valueField, agg: editPivot.agg || 'SUM', display: 'raw' }]
        : []
  )
  const [title, setTitle] = useState(editPivot?.title || '')

  // Headers available for the current range (live).
  const headers = useMemo(
    () => pivotHeaders(makePivot({ range }), activeSheet || {}),
    [range, activeSheet]
  )

  // Default field selections when headers first resolve (insert flow only).
  useEffect(() => {
    if (isEditing || headers.length === 0) return
    setRowField((v) => v || headers[0] || '')
    setValues((vs) => (vs.length ? vs : [{ field: headers[2] || headers[1] || headers[0], agg: 'SUM', display: 'raw' }]))
  }, [headers, isEditing])

  const draft = useMemo(
    () => makePivot({ id: editPivot?.id, range, rowField, colField, rowGroup, colGroup, values, title }),
    [editPivot, range, rowField, colField, rowGroup, colGroup, values, title]
  )
  const model = useMemo(() => computePivotModel(draft, activeSheet || {}), [draft, activeSheet])
  const preview = model?.table || null

  function patchValue(i: number, patch: Partial<PivotValueSpec>) {
    setValues((vs) => vs.map((v, j) => (j === i ? { ...v, ...patch } : v)))
  }
  function addValue() {
    setValues((vs) => (vs.length >= MAX_VALUES ? vs : [...vs, { field: headers[0] || '', agg: 'SUM', display: 'raw' }]))
  }
  function removeValue(i: number) {
    setValues((vs) => vs.filter((_, j) => j !== i))
  }

  function handleCommit() {
    const patch = { range, rowField, colField, rowGroup, colGroup, values, title }
    const next = isEditing && editPivot ? updatePivot(data, editPivot.id, patch) : insertPivot(data, patch)
    onInsert(next)
    onClose()
  }

  // "Insert as static sheet" — materialise the CURRENT result into a real sheet
  // (celldata) so it exports to XLSX / is formula-referenceable. Snapshot, not
  // reactive; distinct from the live pivot above.
  function handleInsertStatic() {
    if (!onInsertStatic) return
    const sheet = pivotToSheet(draft, activeSheet || {}, title)
    if (sheet) onInsertStatic([...data, sheet as unknown as PivotSheet])
    onClose()
  }

  const sel = 'w-full rounded-md border border-line bg-bg px-2 py-1.5 text-xs text-ink focus:outline-none focus:border-line-strong'
  const selSm = 'w-full rounded-md border border-line bg-bg px-1.5 py-1 text-[11px] text-ink focus:outline-none focus:border-line-strong'
  const pctCols = useMemo(() => {
    const s = new Set<number>()
    ;(model?.displays || []).forEach((d, i) => { if (d && d !== 'raw') s.add(i) })
    return s
  }, [model])

  return (
    <div className="flex flex-col w-full sm:w-72 flex-shrink-0 h-full border-l border-line bg-paper overflow-y-auto">
      <div className="flex items-center justify-between px-3 py-2 border-b border-line">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-ink tracking-tightish">
          <Table2 size={13} /> {isEditing ? 'Edit pivot' : 'Pivot table'}
        </span>
        <IconButton size="sm" title="Close" onClick={onClose}><X size={13} /></IconButton>
      </div>

      <div className="flex-1 px-3 py-3 space-y-4 text-xs">
        <div className="space-y-1">
          <label className="block text-ink-muted font-medium" htmlFor="pivot-range">Source range</label>
          <input id="pivot-range" value={range} onChange={(e) => setRange(e.target.value)} className={sel} placeholder="e.g. A1:D100" />
        </div>

        {headers.length === 0 ? (
          <p className="text-ink-faint">No headers found in that range. The first row of the range should hold column names.</p>
        ) : (
          <>
            <div className="space-y-1">
              <label className="block text-ink-muted font-medium" htmlFor="pivot-row">Row field</label>
              <select id="pivot-row" value={rowField} onChange={(e) => setRowField(e.target.value)} className={sel}>
                <option value="">— choose —</option>
                {headers.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
              {rowField && (
                <select
                  aria-label="Group row dates"
                  value={rowGroup}
                  onChange={(e) => setRowGroup(e.target.value as PivotGrouping)}
                  className={selSm}
                >
                  {PIVOT_GROUPINGS.map((g) => <option key={g} value={g}>{PIVOT_GROUPING_LABEL[g]}</option>)}
                </select>
              )}
            </div>

            <div className="space-y-1">
              <label className="block text-ink-muted font-medium" htmlFor="pivot-col">Column field</label>
              <select id="pivot-col" value={colField} onChange={(e) => setColField(e.target.value)} className={sel}>
                <option value="">— none —</option>
                {headers.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
              {colField && (
                <select
                  aria-label="Group column dates"
                  value={colGroup}
                  onChange={(e) => setColGroup(e.target.value as PivotGrouping)}
                  className={selSm}
                >
                  {PIVOT_GROUPINGS.map((g) => <option key={g} value={g}>{PIVOT_GROUPING_LABEL[g]}</option>)}
                </select>
              )}
            </div>

            {/* Value fields — one row each: field · aggregation · display. */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-ink-muted font-medium">Values</span>
                <button
                  type="button"
                  onClick={addValue}
                  disabled={values.length >= MAX_VALUES || !headers.length}
                  className="flex items-center gap-1 text-[11px] text-accent hover:underline disabled:opacity-40 disabled:no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 rounded"
                >
                  <Plus size={11} aria-hidden /> Add value
                </button>
              </div>

              {values.length === 0 ? (
                <p className="text-ink-faint text-[11px]">
                  No value field yet — add one to aggregate a column.
                </p>
              ) : (
                values.map((v, i) => (
                  <div key={i} className="rounded-md border border-line p-1.5 space-y-1 bg-bg/40">
                    <div className="flex items-center gap-1">
                      <select
                        aria-label={`Value field ${i + 1}`}
                        value={v.field}
                        onChange={(e) => patchValue(i, { field: e.target.value })}
                        className={selSm}
                      >
                        <option value="">— choose —</option>
                        {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                      </select>
                      <IconButton
                        size="sm"
                        title={`Remove value ${i + 1}`}
                        aria-label={`Remove value ${i + 1}`}
                        onClick={() => removeValue(i)}
                      >
                        <Trash2 size={11} />
                      </IconButton>
                    </div>
                    <div className="grid grid-cols-2 gap-1">
                      <select
                        aria-label={`Aggregation for value ${i + 1}`}
                        value={v.agg}
                        onChange={(e) => patchValue(i, { agg: e.target.value as PivotAgg })}
                        className={selSm}
                      >
                        {PIVOT_AGGS.map((k) => <option key={k} value={k}>{k}</option>)}
                      </select>
                      <select
                        aria-label={`Display for value ${i + 1}`}
                        value={v.display}
                        onChange={(e) => patchValue(i, { display: e.target.value as PivotDisplay })}
                        className={selSm}
                      >
                        {PIVOT_DISPLAYS.map((d) => <option key={d} value={d}>{PIVOT_DISPLAY_LABEL[d]}</option>)}
                      </select>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="space-y-1">
              <label className="block text-ink-muted font-medium" htmlFor="pivot-title">Title (optional)</label>
              <input id="pivot-title" value={title} onChange={(e) => setTitle(e.target.value)} className={sel} placeholder="Pivot title" />
            </div>

            <div className="flex flex-col gap-1.5">
              <Button variant="primary" size="sm" onClick={handleCommit} className="w-full" disabled={!preview}>
                {isEditing ? 'Update pivot' : 'Insert live pivot'}
              </Button>
              {!isEditing && onInsertStatic && (
                <Button variant="secondary" size="sm" onClick={handleInsertStatic} className="w-full" disabled={!preview}>
                  Insert as static sheet (exportable)
                </Button>
              )}
            </div>

            {preview ? (
              <div className="overflow-auto border border-line rounded-md">
                <div className="flex items-center gap-1 px-2 py-1 text-[10px] text-ink-faint border-b border-line">
                  <RefreshCw size={9} /> Live preview — updates when source cells change
                </div>
                <table className="text-xs w-full border-collapse">
                  <thead>
                    <tr>
                      {preview[0].map((h, i) => (
                        <th key={i} className="px-1.5 py-1 border border-line bg-bg text-ink-muted font-semibold text-left whitespace-nowrap">
                          {String(h)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.slice(1).map((row, ri) => (
                      <tr key={ri} className={ri % 2 === 0 ? '' : 'bg-bg'}>
                        {row.map((cell, ci) => (
                          <td key={ci} className="px-1.5 py-0.5 border border-line text-ink whitespace-nowrap">
                            {typeof cell === 'number'
                              ? cell.toLocaleString(undefined, { maximumFractionDigits: 4 }) + (pctCols.has(ci) ? '%' : '')
                              : String(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-ink-faint text-[11px]">Pick a Row field and at least one Value field that match header names to preview.</p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
