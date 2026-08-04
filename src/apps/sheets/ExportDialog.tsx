/**
 * src/apps/sheets/ExportDialog.tsx  (WAVE-64)
 *
 * The export confirmation for Sheets — the surface that makes export fidelity
 * HONEST.
 *
 * Before WAVE-64 the .xlsx export dropped every chart into a side "metadata"
 * worksheet and said nothing: the user got a file that silently lacked their
 * charts. Now the xlsx writer embeds real OOXML charts (xlsxCharts.js), but not
 * every format can carry everything — .ods cannot embed a chart at all, .csv is
 * values-only, and a live pivot is a view, not cells. Anything that will NOT
 * survive the chosen format is stated here, in plain words, BEFORE the download
 * starts, with a Cancel that actually cancels.
 *
 * The dialog only appears when there is something to say (charts / pivots exist);
 * a plain workbook exports with no friction at all.
 *
 * A11Y: focus-trapped modal (useDialogA11y), Escape closes, the primary action is
 * focused on open, and the caveat list is a real <ul> announced by the dialog's
 * aria-describedby.
 */
import { useRef, useEffect } from 'react'
import { X, Download, AlertTriangle, Info, CheckCircle2 } from 'lucide-react'
import { Button, IconButton, useDialogA11y } from '../../components/ui'
import { exportFidelity, type ExportSheet } from './sheetsExport.js'

export interface ExportDialogProps {
  data: ExportSheet[]
  format: string
  onCancel: () => void
  onConfirm: (format: string) => void
}

const FORMAT_LABEL: Record<string, string> = {
  xlsx: 'Excel workbook (.xlsx)',
  ods: 'OpenDocument sheet (.ods)',
  csv: 'CSV (.csv)',
  'xlsx-server': 'Server Excel workbook (.xlsx)',
}

export default function ExportDialog({ data, format, onCancel, onConfirm }: ExportDialogProps) {
  const report = exportFidelity(data, format)
  const dialogRef = useRef<HTMLDivElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  useDialogA11y(dialogRef, onCancel)
  useEffect(() => { confirmRef.current?.focus() }, [])

  const missing = report.missing
  const hasMissing = !!missing && (missing.pivots > 0 || missing.charts.length > 0)
  const hasLoss = report.lost.length > 0 || hasMissing
  const titleId = 'export-dialog-title'
  const descId = 'export-dialog-desc'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="bg-paper rounded-xl border border-line shadow-e3 w-[440px] max-h-[85vh] flex flex-col overflow-hidden animate-scale-in"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-line">
          <span id={titleId} className="text-sm font-semibold text-ink flex items-center gap-2">
            <Download size={14} className="text-accent" aria-hidden />
            Export as {FORMAT_LABEL[format] || format}
          </span>
          <IconButton size="sm" title="Close" onClick={onCancel}><X size={13} /></IconButton>
        </div>

        <div id={descId} className="flex-1 overflow-y-auto px-4 py-4 space-y-3 text-xs">
          {/* Content the IMPORT could never bring in. It is not in this workbook,
              so nothing else here can see it — but the user is about to write a
              file back over an original that still HAS it. Say so first. */}
          {hasMissing && missing && (
            <div className="rounded-lg border border-line bg-warning-bg p-3 space-y-1.5" role="alert">
              <p className="flex items-center gap-1.5 font-semibold text-ink">
                <AlertTriangle size={13} className="text-warning" aria-hidden />
                Not in this workbook — and not in the export
              </p>
              <p className="text-ink-muted">
                {missing.filename ? <>“{missing.filename}” had content Vulos could not import.</>
                  : <>The file this workbook came from had content Vulos could not import.</>}
                {' '}Exporting will not put it back.
              </p>
              <ul className="space-y-0.5 text-ink-muted">
                {missing.pivots > 0 && (
                  <li className="flex gap-1.5">
                    <span aria-hidden>•</span>
                    <span>
                      <span className="font-medium text-ink">
                        {missing.pivots} pivot table{missing.pivots === 1 ? '' : 's'}
                      </span>
                      {' — '}imported as ordinary cells (the values are here; the live pivot is not)
                    </span>
                  </li>
                )}
                {missing.charts.slice(0, 5).map((c, i) => (
                  <li key={i} className="flex gap-1.5">
                    <span aria-hidden>•</span>
                    <span>
                      <span className="font-medium text-ink">{c.title || 'Untitled chart'}</span>
                      {' — '}{c.reason}
                    </span>
                  </li>
                ))}
                {missing.charts.length > 5 && (
                  <li className="text-ink-faint">…and {missing.charts.length - 5} more</li>
                )}
              </ul>
            </div>
          )}

          {/* What will NOT survive this format — stated next, never buried. */}
          {report.lost.length > 0 && (
            <div className="rounded-lg border border-line bg-warning-bg p-3 space-y-1.5" role="alert">
              <p className="flex items-center gap-1.5 font-semibold text-ink">
                <AlertTriangle size={13} className="text-warning" aria-hidden />
                {report.lost.length} chart{report.lost.length === 1 ? '' : 's'} can’t be embedded in this format
              </p>
              <ul className="space-y-0.5 text-ink-muted">
                {report.lost.slice(0, 6).map((l, i) => (
                  <li key={i} className="flex gap-1.5">
                    <span aria-hidden>•</span>
                    <span>
                      <span className="font-medium text-ink">{l.title || `Untitled ${l.type}`}</span>
                      {' — '}{l.note}
                    </span>
                  </li>
                ))}
                {report.lost.length > 6 && (
                  <li className="text-ink-faint">…and {report.lost.length - 6} more</li>
                )}
              </ul>
            </div>
          )}

          {/* Caveats on charts that DO embed. */}
          {report.degraded.length > 0 && (
            <div className="rounded-lg border border-line bg-bg p-3 space-y-1.5">
              <p className="flex items-center gap-1.5 font-semibold text-ink">
                <Info size={13} className="text-ink-muted" aria-hidden />
                Embedded with a caveat
              </p>
              <ul className="space-y-0.5 text-ink-muted">
                {report.degraded.slice(0, 6).map((d, i) => (
                  <li key={i} className="flex gap-1.5">
                    <span aria-hidden>•</span>
                    <span>
                      <span className="font-medium text-ink">{d.title || `Untitled ${d.type}`}</span>
                      {' — '}{d.note}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Everything else worth knowing (what DOES survive, pivots, CSV scope). */}
          {report.notes.length > 0 && (
            <ul className="space-y-1.5 text-ink-muted">
              {report.notes.map((n, i) => (
                <li key={i} className="flex gap-1.5">
                  <CheckCircle2 size={12} className="text-success mt-0.5 flex-shrink-0" aria-hidden />
                  <span>{n}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between px-4 py-3 border-t border-line gap-2">
          <Button variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
          <Button ref={confirmRef} variant="primary" size="sm" onClick={() => onConfirm(format)}>
            {hasLoss ? 'Export anyway' : 'Export'}
          </Button>
        </div>
      </div>
    </div>
  )
}
