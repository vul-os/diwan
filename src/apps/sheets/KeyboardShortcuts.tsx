/**
 * src/apps/sheets/KeyboardShortcuts.tsx
 *
 * Google Sheets parity keyboard shortcuts:
 *   Cmd+B/I/U      — bold/italic/underline (Fortune Sheet handles natively)
 *   Cmd+;          — insert today's date
 *   Cmd+:          — insert current time
 *   Cmd+Shift+V    — paste values only (intercepted, re-emitted without format)
 *   Cmd+/          — show shortcuts help overlay
 *   Cmd+Enter      — fill down selection
 *
 * Usage:
 *   import { useSheetKeyboardShortcuts } from './KeyboardShortcuts.jsx'
 *   // In SheetsEditor, inside the workbook wrapper div:
 *   useSheetKeyboardShortcuts({ workbookRef, data, onChange, onShowHelp })
 *
 * Also exports <KeyboardShortcutsHelp /> — the help overlay.
 */
import { useEffect, useCallback, useState, type RefObject } from 'react'
import { Modal } from '../../components/ui'

export interface KSCellValue {
  v?: string | number | boolean
  m?: string | number
  ct?: { fa?: string; t?: string }
  [key: string]: unknown
}
export interface KSCellEntry {
  r: number
  c: number
  v?: KSCellValue | null
}
export interface KSSheet {
  celldata?: KSCellEntry[]
  [key: string]: unknown
}

// ── Utility ───────────────────────────────────────────────────────────────────

function pad(n: number): string { return String(n).padStart(2, '0') }

function todayString(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function nowString(): string {
  const d = new Date()
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** Get the focused cell from Fortune Sheet's DOM (best-effort). */
function getFocusedCellAddress(): string | null {
  // Fortune Sheet shows the selected cell in .luckysheet-input-box-index
  const el = document.querySelector('.luckysheet-input-box-index')
  if (!el) return null
  return el.textContent?.trim() || null
}

/**
 * Set a cell value in the Fortune Sheet data structure (immutable update).
 * Returns new data array or null if cell address could not be resolved.
 */
function setCellValueInData(data: KSSheet[], addr: string | null, value: string): KSSheet[] | null {
  // addr is e.g. "A1" — convert to row/col (0-indexed).
  if (!addr) return null
  const match = addr.match(/^([A-Z]+)(\d+)$/)
  if (!match) return null
  const colStr = match[1]
  const row    = parseInt(match[2], 10) - 1
  let col = 0
  for (let i = 0; i < colStr.length; i++) {
    col = col * 26 + (colStr.charCodeAt(i) - 64)
  }
  col -= 1

  return data.map((sheet, idx) => {
    if (idx !== 0) return sheet
    const existing = (sheet.celldata || []).filter((c) => !(c.r === row && c.c === col))
    existing.push({
      r: row, c: col,
      v: { v: value, m: String(value), ct: { fa: 'General', t: 's' } },
    })
    return { ...sheet, celldata: existing }
  })
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export interface UseSheetKeyboardShortcutsOpts {
  containerRef?: RefObject<HTMLElement | null> | null
  data: KSSheet[]
  onChange: (data: KSSheet[]) => void
  onShowHelp?: () => void
}

/**
 * useSheetKeyboardShortcuts
 *
 * @param {object} opts
 * @param {React.RefObject} opts.containerRef  — ref to the workbook wrapper element
 * @param {Sheet[]}         opts.data          — current sheet data
 * @param {fn}              opts.onChange       — called with new data on cell edit
 * @param {fn}              opts.onShowHelp     — called to open the help overlay
 */
export function useSheetKeyboardShortcuts({ containerRef, data, onChange, onShowHelp }: UseSheetKeyboardShortcutsOpts): void {
  const isMac = navigator.platform?.startsWith('Mac') ?? true
  const META: 'metaKey' | 'ctrlKey' = isMac ? 'metaKey' : 'ctrlKey'

  const handler = useCallback((e: KeyboardEvent) => {
    if (!e[META]) return

    // Cmd+/ → show shortcuts help
    if (e.key === '/') {
      e.preventDefault()
      onShowHelp?.()
      return
    }

    // Cmd+; → insert date
    if (e.key === ';') {
      e.preventDefault()
      const addr = getFocusedCellAddress()
      const next = setCellValueInData(data, addr, todayString())
      if (next) onChange(next)
      return
    }

    // Cmd+: → insert time  (macOS gives ':' with Shift+; but key='Dead' sometimes)
    // We detect both Shift+; and ':'.
    if ((e.key === ':' || (e.shiftKey && e.key === ';'))) {
      e.preventDefault()
      const addr = getFocusedCellAddress()
      const next = setCellValueInData(data, addr, nowString())
      if (next) onChange(next)
      return
    }

    // Cmd+Shift+V → paste values only (strip formatting, re-inject as plain text).
    if (e.shiftKey && (e.key === 'V' || e.key === 'v')) {
      e.preventDefault()
      e.stopPropagation()
      if (!navigator.clipboard?.readText) return
      navigator.clipboard.readText().then(text => {
        if (!text) return
        const addr = getFocusedCellAddress()
        if (!addr) return
        // Parse addr to get start row/col (addr is like "A1").
        const addrMatch = addr.match(/^([A-Z]+)(\d+)$/)
        if (!addrMatch) return
        const startRow = parseInt(addrMatch[2], 10) - 1
        let startCol = 0
        for (let i = 0; i < addrMatch[1].length; i++) {
          startCol = startCol * 26 + (addrMatch[1].charCodeAt(i) - 64)
        }
        startCol -= 1
        // Parse clipboard as TSV (tab-separated columns, newline-separated rows).
        const rows = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
        // Trim trailing empty row from trailing newline.
        if (rows.length > 1 && rows[rows.length - 1] === '') rows.pop()
        // Build column letter from 0-based index.
        function colLetter(n: number): string {
          let s = ''
          n += 1
          while (n > 0) {
            n--
            s = String.fromCharCode(65 + (n % 26)) + s
            n = Math.floor(n / 26)
          }
          return s
        }
        let nextData = data
        for (let ri = 0; ri < rows.length; ri++) {
          const cols = rows[ri].split('\t')
          for (let ci = 0; ci < cols.length; ci++) {
            let val = cols[ci]
            // Values-only paste: if value starts with '=' treat as string literal.
            if (val.startsWith('=')) val = "'" + val
            const targetAddr = colLetter(startCol + ci) + String(startRow + ri + 1)
            const next = setCellValueInData(nextData, targetAddr, val)
            if (next) nextData = next
          }
        }
        if (nextData !== data) onChange(nextData)
      })
      return
    }

  }, [data, onChange, onShowHelp, META])

  useEffect(() => {
    const el: HTMLElement | Window = containerRef?.current ?? window
    el.addEventListener('keydown', handler as EventListener, true)
    return () => el.removeEventListener('keydown', handler as EventListener, true)
  }, [containerRef, handler])
}

// ── Help overlay ──────────────────────────────────────────────────────────────

const SHORTCUTS = [
  { keys: '⌘ B',        desc: 'Bold' },
  { keys: '⌘ I',        desc: 'Italic' },
  { keys: '⌘ U',        desc: 'Underline' },
  { keys: '⌘ ;',        desc: 'Insert today\'s date' },
  { keys: '⌘ :',        desc: 'Insert current time' },
  { keys: '⌘ ⇧ V',     desc: 'Paste values only' },
  { keys: '⌘ /',        desc: 'Keyboard shortcuts help' },
  { keys: 'F4',         desc: 'Toggle absolute reference in formula' },
  { keys: '⌘ ↵',       desc: 'Fill down (Fortune Sheet built-in)' },
  { keys: '⌘ Z',        desc: 'Undo (Fortune Sheet built-in)' },
  { keys: '⌘ Y',        desc: 'Redo (Fortune Sheet built-in)' },
  { keys: '⌘ F',        desc: 'Find (Fortune Sheet built-in)' },
  { keys: '⌘ A',        desc: 'Select all (Fortune Sheet built-in)' },
  { keys: 'Tab / ⇧Tab', desc: 'Move right / left between cells' },
  { keys: '↵',          desc: 'Confirm edit, move down' },
]

export function KeyboardShortcutsHelp({ onClose }: { onClose: () => void }) {
  return (
    <Modal open onClose={onClose} size="md" title="Keyboard shortcuts">
      <Modal.Body className="max-h-[70vh] overflow-y-auto">
        <table className="w-full text-xs border-collapse">
          <tbody>
            {SHORTCUTS.map(({ keys, desc }, i) => (
              <tr key={i} className={i % 2 === 0 ? 'bg-bg/50' : ''}>
                <td className="py-1.5 pr-4 font-mono font-medium text-ink whitespace-nowrap">
                  {keys}
                </td>
                <td className="py-1.5 text-ink-muted">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Modal.Body>
    </Modal>
  )
}

// ── useShowHelp convenience hook ──────────────────────────────────────────────

export function useShortcutsHelp() {
  const [show, setShow] = useState(false)
  return { show, openHelp: () => setShow(true), closeHelp: () => setShow(false) }
}
