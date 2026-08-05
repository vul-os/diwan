/**
 * SheetsFindReplace — find and replace across all sheets in Fortune Sheet data.
 *
 * Usage:
 *   <SheetsFindReplace data={data} onChange={handleChange} onClose={onClose} />
 *
 * Keyboard:
 *   Enter / F3    — next match
 *   Shift+Enter   — previous match
 *   Escape        — close
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { Search, X, ChevronUp, ChevronDown, ArrowRight } from 'lucide-react'

export interface FRCellValue {
  v?: string | number | boolean
  m?: string | number
  [key: string]: unknown
}
export interface FRCellEntry {
  r: number
  c: number
  v?: FRCellValue | string | number | boolean | null
}
export interface FRSheet {
  celldata?: FRCellEntry[]
  [key: string]: unknown
}

export interface FoundCell {
  sheetIdx: number
  r: number
  c: number
  value: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Collect all non-empty cells across all sheets.
 * Returns [{sheetIdx, r, c, value}]
 */
function collectCells(data: FRSheet[]): FoundCell[] {
  const cells: FoundCell[] = []
  for (let si = 0; si < data.length; si++) {
    const sheet = data[si]
    for (const cell of (sheet.celldata || [])) {
      const raw = cell.v
      const val = typeof raw === 'object' && raw !== null ? (raw?.m ?? raw?.v ?? '') : (raw ?? '')
      if (val !== '' && val !== null && val !== undefined) {
        cells.push({ sheetIdx: si, r: cell.r, c: cell.c, value: String(val) })
      }
    }
  }
  return cells
}

/**
 * Find all matches for `term` in the cell list.
 * Returns indices into the flat cells array.
 */
function findMatches(cells: FoundCell[], term: string, matchCase: boolean): number[] {
  if (!term) return []
  const needle = matchCase ? term : term.toLowerCase()
  const indices: number[] = []
  for (let i = 0; i < cells.length; i++) {
    const haystack = matchCase ? cells[i].value : cells[i].value.toLowerCase()
    if (haystack.includes(needle)) indices.push(i)
  }
  return indices
}

/**
 * Apply a replace on all matched cells.  Returns a new data array.
 */
function applyReplace(
  data: FRSheet[],
  cells: FoundCell[],
  matchIndices: number[],
  term: string,
  replacement: string,
  matchCase: boolean,
): FRSheet[] {
  if (!term || matchIndices.length === 0) return data

  // Build a map: sheetIdx → r_c → replacement value
  const patchMap = new Map<string, { sheetIdx: number; r: number; c: number; newVal: string }>()
  for (const idx of matchIndices) {
    const cell = cells[idx]
    const regex = new RegExp(
      term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      matchCase ? 'g' : 'gi'
    )
    const newVal = cell.value.replace(regex, replacement)
    const key = `${cell.sheetIdx}:${cell.r}:${cell.c}`
    patchMap.set(key, { sheetIdx: cell.sheetIdx, r: cell.r, c: cell.c, newVal })
  }

  return data.map((sheet, si) => {
    const celldata = (sheet.celldata || []).map((cell) => {
      const key = `${si}:${cell.r}:${cell.c}`
      const patch = patchMap.get(key)
      if (!patch) return cell
      const updated = {
        ...cell,
        v: typeof cell.v === 'object' && cell.v !== null
          ? { ...cell.v, v: patch.newVal, m: patch.newVal }
          : patch.newVal,
      }
      return updated
    })
    return { ...sheet, celldata }
  })
}

// ── Component ─────────────────────────────────────────────────────────────────

export interface SheetsFindReplaceProps {
  data: FRSheet[]
  onChange: (data: FRSheet[]) => void
  onClose: () => void
}

export default function SheetsFindReplace({ data, onChange, onClose }: SheetsFindReplaceProps) {
  const [term, setTerm]           = useState('')
  const [replacement, setReplacement] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [showReplace, setShowReplace] = useState(false)
  const [matchIdx, setMatchIdx]   = useState(0)  // current match index (into matchIndices)
  const [_highlighted, setHighlighted] = useState<{ sheetIdx: number; r: number; c: number } | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)

  // Focus the search input on mount.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Derive flat cell list + matches.
  const cells   = collectCells(data)
  const matches = findMatches(cells, term, matchCase)
  const count   = matches.length

  // Clamp matchIdx when count changes.
  const safeIdx = count > 0 ? Math.min(matchIdx, count - 1) : 0

  // Highlight the current match cell.
  useEffect(() => {
    if (count === 0) { setHighlighted(null); return }
    const cell = cells[matches[safeIdx]]
    setHighlighted(cell ? { sheetIdx: cell.sheetIdx, r: cell.r, c: cell.c } : null)
  }, [term, matchCase, safeIdx, count]) // eslint-disable-line

  const goNext = useCallback(() => {
    if (count === 0) return
    setMatchIdx((i) => (i + 1) % count)
  }, [count])

  const goPrev = useCallback(() => {
    if (count === 0) return
    setMatchIdx((i) => (i - 1 + count) % count)
  }, [count])

  const handleReplaceOne = () => {
    if (count === 0) return
    const newData = applyReplace(data, cells, [matches[safeIdx]], term, replacement, matchCase)
    onChange(newData)
    // Stay on same index (next cell may have shifted but close enough for UX).
  }

  const handleReplaceAll = () => {
    if (count === 0) return
    const newData = applyReplace(data, cells, matches, term, replacement, matchCase)
    onChange(newData)
    setMatchIdx(0)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { onClose(); return }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) goPrev()
      else goNext()
    }
  }

  return (
    <div
      className="absolute top-1 right-2 left-2 sm:left-auto z-50 bg-paper border border-line rounded-lg shadow-e2 p-3 w-auto sm:w-80 animate-scale-in"
      role="dialog"
      aria-label="Find and replace in sheet"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-ink-muted tracking-tightish flex items-center gap-1.5">
          <Search size={12} />
          Find in sheet
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setShowReplace((v) => !v)}
            className="text-2xs text-ink-faint hover:text-ink transition-colors px-1"
            aria-pressed={showReplace}
          >
            {showReplace ? 'Hide replace' : 'Replace'}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close find bar"
            className="text-ink-faint hover:text-ink transition-colors"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Search row */}
      <div className="flex items-center gap-1.5 mb-1.5">
        <input
          ref={inputRef}
          type="text"
          value={term}
          onChange={(e) => { setTerm(e.target.value); setMatchIdx(0) }}
          onKeyDown={handleKeyDown}
          placeholder="Find…"
          aria-label="Search term"
          className={[
            'flex-1 h-7 text-xs px-2 rounded-sm border',
            'bg-bg text-ink placeholder:text-ink-faint',
            'focus:outline-none focus:border-accent transition-colors',
            term && count === 0 ? 'border-danger' : 'border-line',
          ].join(' ')}
        />
        <button
          type="button"
          onClick={goPrev}
          disabled={count === 0}
          aria-label="Previous match"
          className="toolbar-btn disabled:opacity-40"
        >
          <ChevronUp size={13} />
        </button>
        <button
          type="button"
          onClick={goNext}
          disabled={count === 0}
          aria-label="Next match"
          className="toolbar-btn disabled:opacity-40"
        >
          <ChevronDown size={13} />
        </button>
      </div>

      {/* Match case toggle + count */}
      <div className="flex items-center justify-between mb-1.5">
        <label className="flex items-center gap-1.5 text-2xs text-ink-muted cursor-pointer select-none">
          <input
            type="checkbox"
            checked={matchCase}
            onChange={(e) => { setMatchCase(e.target.checked); setMatchIdx(0) }}
            className="rounded-xs border border-line"
          />
          Match case
        </label>
        <span className="text-2xs text-ink-faint tabular-nums">
          {term
            ? count === 0
              ? 'No results'
              : `${safeIdx + 1} / ${count}`
            : ''}
        </span>
      </div>

      {/* Replace row */}
      {showReplace && (
        <>
          <div className="border-t border-line my-2" />
          <div className="flex items-center gap-1.5 mb-1.5">
            <input
              type="text"
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Replace with…"
              aria-label="Replacement text"
              className={[
                'flex-1 h-7 text-xs px-2 rounded-sm border border-line',
                'bg-bg text-ink placeholder:text-ink-faint',
                'focus:outline-none focus:border-accent transition-colors',
              ].join(' ')}
            />
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={handleReplaceOne}
              disabled={count === 0}
              className={[
                'flex items-center gap-1 h-6 px-2 text-2xs rounded-sm border border-line',
                'text-ink-muted hover:text-ink hover:border-line-strong transition-colors',
                'disabled:opacity-40',
              ].join(' ')}
            >
              <ArrowRight size={11} /> Replace
            </button>
            <button
              type="button"
              onClick={handleReplaceAll}
              disabled={count === 0}
              className={[
                'flex items-center gap-1 h-6 px-2 text-2xs rounded-sm border border-accent',
                'text-accent hover:bg-accent-tint transition-colors',
                'disabled:opacity-40',
              ].join(' ')}
            >
              Replace all ({count})
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// Export helpers for tests
export { collectCells, findMatches, applyReplace }
