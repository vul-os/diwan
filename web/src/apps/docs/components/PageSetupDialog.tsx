/**
 * PageSetupDialog — P3: page size, orientation, margins.
 *
 * Edits a page-setup config and applies it. The config drives the paper card
 * dimensions (P1 pagination) and export geometry. All values are enumerated /
 * numeric and validated by normalizePageSetup on apply.
 */

import { useEffect, useState } from 'react'
import Modal from '../../../components/ui/Modal'
import { Button } from '../../../components/ui'
import { PAGE_SIZES, normalizePageSetup, type Margins, type PageSetup, type PageSizeKey } from '../pageSetup.js'

// While editing, a margin field may transiently hold '' (user cleared the
// input) before normalizePageSetup coerces it back to a number on apply.
type EditableCfg = Omit<PageSetup, 'margins'> & { margins: { [K in keyof Margins]: number | '' } }

export interface PageSetupDialogProps {
  open: boolean
  value: unknown
  onApply?: (cfg: PageSetup) => void
  onClose?: () => void
}

export default function PageSetupDialog({ open, value, onApply, onClose }: PageSetupDialogProps) {
  const [cfg, setCfg] = useState<EditableCfg>(normalizePageSetup(value))

  useEffect(() => { if (open) setCfg(normalizePageSetup(value)) }, [open, value])

  const setMargin = (side: keyof Margins, v: string) => {
    const n = v === '' ? '' : parseFloat(v)
    setCfg((c) => ({ ...c, margins: { ...c.margins, [side]: typeof n === 'number' && Number.isNaN(n) ? 0 : n } }))
  }

  const apply = () => { onApply?.(normalizePageSetup(cfg)); onClose?.() }

  return (
    <Modal open={open} onClose={onClose} title="Page setup" size="md">
      <Modal.Body className="space-y-4">
        {/* Size */}
        <label className="block">
          <span className="text-2xs font-semibold text-ink-faint tracking-eyebrow uppercase">Paper size</span>
          <select
            value={cfg.size}
            onChange={(e) => setCfg((c) => ({ ...c, size: e.target.value as PageSizeKey }))}
            aria-label="Paper size"
            className="mt-1 w-full text-sm px-3 py-2 rounded-md border border-line bg-paper text-ink focus:outline-none focus:border-accent"
          >
            {Object.entries(PAGE_SIZES).map(([key, s]) => (
              <option key={key} value={key}>{s.label}</option>
            ))}
          </select>
        </label>

        {/* Orientation */}
        <fieldset>
          <legend className="text-2xs font-semibold text-ink-faint tracking-eyebrow uppercase">Orientation</legend>
          <div className="mt-1 flex gap-2">
            {(['portrait', 'landscape'] as const).map((o) => (
              <label
                key={o}
                className={`flex-1 flex items-center justify-center gap-2 h-9 rounded-md border cursor-pointer text-sm capitalize transition-colors ${cfg.orientation === o ? 'border-accent bg-accent-tint-2 text-accent-press' : 'border-line text-ink-muted hover:border-line-strong'}`}
              >
                <input
                  type="radio"
                  name="orientation"
                  value={o}
                  checked={cfg.orientation === o}
                  onChange={() => setCfg((c) => ({ ...c, orientation: o }))}
                  className="sr-only"
                />
                {o}
              </label>
            ))}
          </div>
        </fieldset>

        {/* Margins */}
        <fieldset>
          <legend className="text-2xs font-semibold text-ink-faint tracking-eyebrow uppercase">Margins (inches)</legend>
          <div className="mt-1 grid grid-cols-2 gap-2">
            {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
              <label key={side} className="flex items-center gap-2 text-sm text-ink-muted">
                <span className="capitalize w-14">{side}</span>
                <input
                  type="number"
                  min="0"
                  max="4"
                  step="0.25"
                  value={cfg.margins[side]}
                  onChange={(e) => setMargin(side, e.target.value)}
                  aria-label={`${side} margin`}
                  className="flex-1 text-sm px-2 py-1 rounded border border-line bg-paper text-ink tabular-nums focus:outline-none focus:border-accent"
                />
              </label>
            ))}
          </div>
        </fieldset>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={apply}>Apply</Button>
      </Modal.Footer>
    </Modal>
  )
}
