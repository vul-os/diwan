/**
 * src/apps/sheets/ProtectedRangesPanel.tsx
 *
 * Protected ranges side panel — Google-parity warn / restrict, NO passwords.
 *
 * A range owner marks a rectangle protected and chooses a policy:
 *   - "Show a warning"  (warningOnly) — advisory; editors are warned, not blocked.
 *   - "Restrict who can edit" — only the file owner + the chosen editors may change
 *     the cells. This is enforced SERVER-SIDE, fail-closed (the server refuses a
 *     write to the range by anyone else). The list here just drives that policy.
 *
 * Props:
 *   data          {Sheet[]}   — workbook data
 *   fileId        {string}    — for loading the collaborator roster (editor picker)
 *   me            {string}    — this account id (roster display)
 *   selectionRect {r0,r1,c0,c1}|null — current grid selection to pre-fill the range
 *   onClose       {fn}
 *   onChange      {fn(data)}  — updated workbook data when the list changes
 */
import { useState, useEffect } from 'react'
import { X, Plus, Trash2, ShieldAlert, ShieldCheck } from 'lucide-react'
import { Button, IconButton } from '../../components/ui'
import { api } from '../../lib/api'
import {
  getProtectedRanges, insertProtectedRange, deleteProtectedRange,
  clampRect, rectToA1, makeProtectedRange,
  type ProtectedRangeRect, type PRSheet,
} from './protectedRanges.js'

interface Collaborator {
  account_id: string
  role: string
  [key: string]: unknown
}

interface SelectionRect { r0: number; r1: number; c0: number; c1: number }

export interface ProtectedRangesPanelProps {
  data: PRSheet[]
  fileId?: string | null | undefined
  me?: string | null
  selectionRect?: SelectionRect | null
  onClose: () => void
  onChange?: (data: PRSheet[]) => void
}

// Parse "B2:D10" (or "B2") → rect {startRow,startCol,endRow,endCol}, or null.
function colToIndex(letters: string): number {
  const s = String(letters).toUpperCase()
  let idx = 0
  for (let i = 0; i < s.length; i++) idx = idx * 26 + (s.charCodeAt(i) - 64)
  return idx - 1
}
function parseA1Range(ref: string): ProtectedRangeRect | null {
  const m = String(ref).trim().match(/^([A-Za-z]+)(\d+)(?::([A-Za-z]+)(\d+))?$/)
  if (!m) return null
  const a = { c: colToIndex(m[1]), r: parseInt(m[2], 10) - 1 }
  const b = m[3] ? { c: colToIndex(m[3]), r: parseInt(m[4], 10) - 1 } : a
  if (a.r < 0 || a.c < 0 || b.r < 0 || b.c < 0) return null
  return clampRect({ startRow: a.r, startCol: a.c, endRow: b.r, endCol: b.c })
}

export default function ProtectedRangesPanel({ data, fileId, selectionRect, onClose, onChange }: ProtectedRangesPanelProps) {
  const ranges = getProtectedRanges(data).map(makeProtectedRange)
  const [editing, setEditing] = useState(false)
  const [rangeText, setRangeText] = useState('')
  const [name, setName] = useState('')
  const [warningOnly, setWarningOnly] = useState(false)
  const [editors, setEditors] = useState<string[]>([])
  const [error, setError] = useState('')
  const [roster, setRoster] = useState<Collaborator[]>([]) // [{account_id, role}]
  const [owner, setOwner] = useState('')

  useEffect(() => {
    let live = true
    if (!fileId) return
    api.listFileCollaborators(fileId).then((res) => {
      if (!live) return
      const r = res as { collaborators?: Collaborator[] } | undefined
      const people = Array.isArray(r?.collaborators) ? r.collaborators : []
      setRoster(people)
      const o = people.find((p) => p.role === 'owner')
      if (o) setOwner(o.account_id)
    }).catch(() => { /* roster is best-effort — manual editor ids still work */ })
    return () => { live = false }
  }, [fileId])

  function startNew() {
    // Pre-fill from the current selection when there is one.
    if (selectionRect) {
      setRangeText(rectToA1(clampRect({
        startRow: selectionRect.r0, startCol: selectionRect.c0,
        endRow: selectionRect.r1, endCol: selectionRect.c1,
      })))
    } else {
      setRangeText('')
    }
    setName('')
    setWarningOnly(false)
    setEditors([])
    setError('')
    setEditing(true)
  }

  function toggleEditor(acct: string) {
    setEditors((prev) => prev.includes(acct) ? prev.filter((e) => e !== acct) : [...prev, acct])
  }

  function save() {
    const rect = parseA1Range(rangeText)
    if (!rect) { setError('Enter a range like B2 or B2:D10'); return }
    const next = insertProtectedRange(data, {
      sheetIndex: 0,
      name: name.trim(),
      range: rect,
      warningOnly,
      // The owner is always allowed server-side; do not store them as an editor.
      editors: editors.filter((e) => e && e !== owner),
    })
    setEditing(false)
    onChange?.(next)
  }

  function remove(id: string) {
    onChange?.(deleteProtectedRange(data, id))
  }

  const inputCls = 'w-full rounded border border-line bg-bg px-2 py-1.5 text-xs text-ink focus:outline-none focus:border-line-strong'
  // Everyone who could be granted per-range edit rights: collaborators minus the
  // owner (who always may edit).
  const grantable = roster.filter((p) => p.role !== 'owner')

  return (
    <div className="flex flex-col w-full sm:w-72 flex-shrink-0 h-full border-l border-line bg-paper overflow-y-auto">
      <div className="flex items-center justify-between px-3 py-2 border-b border-line">
        <span className="text-xs font-semibold text-ink tracking-tightish">Protected ranges</span>
        <IconButton size="sm" title="Close" onClick={onClose}><X size={13} /></IconButton>
      </div>

      <div className="flex-1 px-3 py-3 space-y-3 text-xs overflow-y-auto">
        {!editing && (
          <>
            {ranges.length === 0 && (
              <p className="text-ink-faint">No protected ranges. Protect a range to warn editors before a change, or restrict edits to specific people.</p>
            )}

            {ranges.map((r) => (
              <div key={r.id} className="flex items-start gap-2 border border-line rounded-md px-2 py-1.5">
                <div className="mt-0.5">
                  {r.warningOnly
                    ? <ShieldAlert size={13} className="text-warning" aria-label="Warning only" />
                    : <ShieldCheck size={13} className="text-success" aria-label="Restricted" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-ink truncate">{r.name || rectToA1(r.range)}</p>
                  <p className="text-ink-faint text-[10px] truncate">
                    {rectToA1(r.range)} · {r.warningOnly
                      ? 'Warn on edit'
                      : `Only ${r.editors.length ? `${r.editors.length + 1} people` : 'the owner'} can edit`}
                  </p>
                </div>
                <button onClick={() => remove(r.id)} aria-label={`Remove protection on ${r.name || rectToA1(r.range)}`} className="text-ink-faint hover:text-danger mt-0.5 rounded-sm focus-visible:outline-none focus-visible:shadow-focus">
                  <Trash2 size={11} />
                </button>
              </div>
            ))}

            <Button variant="secondary" size="sm" onClick={startNew} className="w-full">
              <Plus size={11} className="mr-1" /> Protect a range
            </Button>
          </>
        )}

        {editing && (
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="block text-ink-muted font-medium">Range</label>
              <input
                value={rangeText}
                onChange={(e) => { setRangeText(e.target.value); setError('') }}
                className={inputCls}
                placeholder="e.g. B2:D10"
                autoFocus
              />
            </div>

            <div className="space-y-1">
              <label className="block text-ink-muted font-medium">Description (optional)</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={inputCls}
                placeholder="e.g. Quarter totals"
              />
            </div>

            <fieldset className="space-y-1.5">
              <legend className="text-ink-muted font-medium mb-1">Protection</legend>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="pr-policy" checked={warningOnly} onChange={() => setWarningOnly(true)} />
                <span className="text-ink">Show a warning when editing</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="pr-policy" checked={!warningOnly} onChange={() => setWarningOnly(false)} />
                <span className="text-ink">Restrict who can edit</span>
              </label>
            </fieldset>

            {!warningOnly && (
              <div className="space-y-1">
                <label className="block text-ink-muted font-medium">Who can edit (besides the owner)</label>
                {grantable.length === 0 && (
                  <p className="text-ink-faint text-[11px]">Share the file with people first to grant them per-range access. Until then, only the owner can edit this range.</p>
                )}
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {grantable.map((p) => (
                    <label key={p.account_id} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={editors.includes(p.account_id)}
                        onChange={() => toggleEditor(p.account_id)}
                      />
                      <span className="text-ink truncate">{p.account_id}</span>
                      <span className="text-ink-faint text-[10px]">{p.role}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {error && <p className="text-danger text-[11px]">{error}</p>}

            <div className="flex gap-2">
              <Button variant="primary" size="sm" onClick={save} className="flex-1">Save</Button>
              <Button variant="secondary" size="sm" onClick={() => setEditing(false)} className="flex-1">Cancel</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
