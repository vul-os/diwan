/**
 * src/apps/sheets/NumberFormatMenu.tsx
 *
 * Compact number-format picker for the Sheets toolbar. Applies a display-format
 * preset (currency / percent / date / …) to the current selection by rewriting
 * only the cells' `ct` descriptor — see ./numberFormats.js. Because it never
 * touches raw cell values, it's transparent to CRDT grid-sync.
 *
 * Props:
 *   selection  {{r0,r1,c0,c1}|null} — current selection rectangle (0-indexed,
 *              inclusive). When null we fall back to the single active cell.
 *   activeCell {{row,col}}
 *   data       {Sheet[]}
 *   onChange   {fn(data)}
 */
import { useEffect, useRef, useState } from 'react'
import { Hash, ChevronDown } from 'lucide-react'
import { IconButton, Tooltip } from '../../components/ui'
import { NUMBER_FORMAT_PRESETS, applyNumberFormat, detectPresetId, type SheetData } from './numberFormats.js'

interface SelectionRect { r0: number; r1: number; c0: number; c1: number }
interface ActiveCell { row?: number; col?: number }

interface NumberFormatMenuProps {
  selection: SelectionRect | null
  activeCell?: ActiveCell | null
  data: SheetData[]
  onChange?: (data: SheetData[]) => void
}

export default function NumberFormatMenu({ selection, activeCell, data, onChange }: NumberFormatMenuProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onKey  = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Resolve the target rectangle from selection, else the active cell.
  const rect = selection && Number.isInteger(selection.r0)
    ? selection
    : { r0: activeCell?.row ?? 0, r1: activeCell?.row ?? 0, c0: activeCell?.col ?? 0, c1: activeCell?.col ?? 0 }

  // Highlight the current active cell's format.
  const activeVal = data?.[0]?.celldata?.find(
    (c) => c.r === (activeCell?.row ?? 0) && c.c === (activeCell?.col ?? 0)
  )?.v
  const currentId = detectPresetId(activeVal)

  function apply(presetId: string) {
    const next = applyNumberFormat(data, [rect.r0, rect.r1], [rect.c0, rect.c1], presetId)
    onChange?.(next)
    setOpen(false)
  }

  return (
    <div ref={ref} className="relative">
      <Tooltip label="Number format">
        <IconButton size="sm" active={open} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>
          <Hash size={14} />
          <ChevronDown size={10} className="opacity-60 -ml-0.5" />
        </IconButton>
      </Tooltip>
      {open && (
        <div
          role="menu"
          aria-label="Number format presets"
          className={[
            'absolute right-0 top-full mt-0.5 w-48 py-1',
            'bg-paper border border-line rounded-md shadow-e2 z-40 text-sm',
            'animate-scale-in',
          ].join(' ')}
        >
          {NUMBER_FORMAT_PRESETS.map((p) => (
            <button
              key={p.id}
              role="menuitemradio"
              aria-checked={p.id === currentId}
              onClick={() => apply(p.id)}
              className={[
                'w-full flex items-center justify-between text-left px-3 py-1.5',
                'hover:bg-accent-tint transition-colors',
                p.id === currentId ? 'text-ink font-medium' : 'text-ink-muted',
              ].join(' ')}
            >
              <span>{p.label}</span>
              {p.id === currentId && <span aria-hidden className="text-accent">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
