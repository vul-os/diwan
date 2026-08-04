/**
 * HeaderFooterDialog — P2: per-document headers & footers.
 *
 * Edits the header/footer bands (left/center/right cells) plus options
 * (enabled, first-page-different, odd/even). Cell values are PLAIN TEXT that may
 * contain field tokens ({{page}}, {{pages}}, {{title}}, {{date}}); they are
 * sanitised to plain text by normalizeHeaderFooter on apply, so this region can
 * carry no markup.
 */

import { useEffect, useState } from 'react'
import Modal from '../../../components/ui/Modal'
import { Button } from '../../../components/ui'
import { normalizeHeaderFooter, type HeaderFooterBand, type HeaderFooterConfig } from '../headerFooter.js'

const FIELDS = [
  { token: '{{page}}', label: 'Page #' },
  { token: '{{pages}}', label: 'Total pages' },
  { token: '{{title}}', label: 'Title' },
  { token: '{{date}}', label: 'Date' },
]

interface BandEditorProps {
  label: string
  band: HeaderFooterBand
  onChange: (band: HeaderFooterBand) => void
}

function BandEditor({ label, band, onChange }: BandEditorProps) {
  const set = (cell: keyof HeaderFooterBand, v: string) => onChange({ ...band, [cell]: v })
  const insertField = (cell: keyof HeaderFooterBand, token: string) => onChange({ ...band, [cell]: `${band[cell] || ''}${token}` })
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-2xs font-semibold text-ink-faint tracking-eyebrow uppercase">{label}</legend>
      <div className="grid grid-cols-3 gap-2">
        {(['left', 'center', 'right'] as const).map((cell) => (
          <div key={cell} className="space-y-1">
            <input
              type="text"
              value={band[cell] || ''}
              onChange={(e) => set(cell, e.target.value)}
              placeholder={cell}
              aria-label={`${label} ${cell}`}
              className="w-full text-xs px-2 py-1 rounded border border-line bg-paper text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent"
            />
            <div className="flex flex-wrap gap-0.5">
              {FIELDS.map((f) => (
                <button
                  key={f.token}
                  type="button"
                  onClick={() => insertField(cell, f.token)}
                  className="px-1 py-0.5 rounded-xs border border-line text-[9px] text-ink-faint hover:border-accent hover:text-ink transition-colors"
                  title={`Insert ${f.token}`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </fieldset>
  )
}

export interface HeaderFooterDialogProps {
  open: boolean
  value: unknown
  onApply?: (cfg: HeaderFooterConfig) => void
  onClose?: () => void
}

export default function HeaderFooterDialog({ open, value, onApply, onClose }: HeaderFooterDialogProps) {
  const [cfg, setCfg] = useState<HeaderFooterConfig>(normalizeHeaderFooter(value))

  useEffect(() => { if (open) setCfg(normalizeHeaderFooter(value)) }, [open, value])

  const apply = () => {
    // Enable automatically if any band has content.
    const hasContent = (b: HeaderFooterBand) => b.left || b.center || b.right
    const enabled = cfg.enabled || hasContent(cfg.header) || hasContent(cfg.footer)
    onApply?.(normalizeHeaderFooter({ ...cfg, enabled }))
    onClose?.()
  }

  return (
    <Modal open={open} onClose={onClose} title="Headers & footers" size="xl">
      <Modal.Body className="space-y-4">
        <label className="flex items-center gap-2 text-sm text-ink-muted">
          <input
            type="checkbox"
            checked={cfg.enabled}
            onChange={(e) => setCfg((c) => ({ ...c, enabled: e.target.checked }))}
          />
          Show headers and footers
        </label>

        <BandEditor
          label="Header"
          band={cfg.header}
          onChange={(header) => setCfg((c) => ({ ...c, header }))}
        />
        <BandEditor
          label="Footer"
          band={cfg.footer}
          onChange={(footer) => setCfg((c) => ({ ...c, footer }))}
        />

        <div className="flex flex-col gap-1.5 pt-1 border-t border-line">
          <label className="flex items-center gap-2 text-sm text-ink-muted">
            <input
              type="checkbox"
              checked={cfg.differentFirstPage}
              onChange={(e) => setCfg((c) => ({ ...c, differentFirstPage: e.target.checked }))}
            />
            Different first page (suppress on page 1)
          </label>
          <label className="flex items-center gap-2 text-sm text-ink-muted">
            <input
              type="checkbox"
              checked={cfg.oddEven}
              onChange={(e) => setCfg((c) => ({ ...c, oddEven: e.target.checked }))}
            />
            Mirror odd/even pages (swap left/right on even pages)
          </label>
        </div>

        <p className="text-2xs text-ink-faint">
          Fields resolve when the document is viewed, printed, or exported:
          <code className="mx-1">{'{{page}}'}</code>
          <code className="mx-1">{'{{pages}}'}</code>
          <code className="mx-1">{'{{title}}'}</code>
          <code className="mx-1">{'{{date}}'}</code>
        </p>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={apply}>Apply</Button>
      </Modal.Footer>
    </Modal>
  )
}
