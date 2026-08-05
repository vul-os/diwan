/**
 * src/apps/sheets/NamedRangesPanel.tsx
 *
 * Named ranges side panel.
 * Persists named ranges in sheet.namedRanges (sheet metadata) — an array of
 * { name, range, sheetName } objects.
 *
 * Props:
 *   data      {Sheet[]}   — workbook data
 *   onClose   {fn}        — close panel
 *   onChange  {fn(data)}  — called with updated data when ranges change
 */
import { useState } from 'react'
import { X, Plus, Trash2, Edit2, Copy, Check } from 'lucide-react'
import { Button, IconButton } from '../../components/ui'

export interface NamedRangeEntry {
  name: string
  range: string
  sheetName: string
}

export interface NRSheet {
  name?: string
  namedRanges?: NamedRangeEntry[]
  [key: string]: unknown
}

export interface NamedRangesPanelProps {
  data: NRSheet[]
  onClose: () => void
  onChange?: (data: NRSheet[]) => void
}

function getNamedRanges(data: NRSheet[] | null | undefined): NamedRangeEntry[] {
  // Stored on the first sheet's metadata for simplicity.
  return data?.[0]?.namedRanges || []
}

// Build the sheet-qualified A1 reference a named range expands to in a formula.
// (Named ranges are made formula-usable by expanding them to this reference —
// see namedRanges.js. FortuneSheet's grammar has no native name binding, so a
// name is entered by referencing its range; this affordance copies exactly that
// reference so the user can paste it into a formula.)
function refFor(r: NamedRangeEntry): string {
  const needsQuote = !/^[A-Za-z_][A-Za-z0-9_]*$/.test(r.sheetName || '')
  const sheet = needsQuote ? `'${String(r.sheetName).replace(/'/g, "''")}'` : r.sheetName
  return r.sheetName ? `${sheet}!${r.range}` : r.range
}

export default function NamedRangesPanel({ data, onClose, onChange }: NamedRangesPanelProps) {
  const [ranges,   setRanges]   = useState<NamedRangeEntry[]>(getNamedRanges(data))
  const [editIdx,  setEditIdx]  = useState<number | null>(null)
  const [form,     setForm]     = useState<NamedRangeEntry>({ name: '', range: '', sheetName: data?.[0]?.name || 'Sheet1' })
  const [editing,  setEditing]  = useState(false)
  const [error,    setError]    = useState('')
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)

  function copyRef(i: number) {
    const ref = refFor(ranges[i])
    // BUG FIX: writeText() returns a Promise (rejects on permission denial);
    // the try/catch here only ever caught a synchronous throw from accessing
    // `navigator.clipboard` itself — the returned promise's rejection was
    // never awaited or caught, so a denial was an unhandled rejection while
    // the UI still showed "Copied" regardless (same class of bug as
    // draftStore.ts's/InstallPrompt.tsx's earlier fixes).
    try { navigator.clipboard?.writeText(ref).catch(() => { /* clipboard blocked — ignore */ }) } catch { /* clipboard blocked — ignore */ }
    setCopiedIdx(i)
    setTimeout(() => setCopiedIdx((c) => (c === i ? null : c)), 1200)
  }

  const sheetNames = (data || []).map((s) => s.name || 'Sheet')

  function startNew() {
    setForm({ name: '', range: '', sheetName: data?.[0]?.name || 'Sheet1' })
    setEditIdx(null)
    setEditing(true)
    setError('')
  }

  function startEdit(i: number) {
    setForm({ ...ranges[i] })
    setEditIdx(i)
    setEditing(true)
    setError('')
  }

  function validate(f: NamedRangeEntry): string | null {
    if (!f.name.trim()) return 'Name is required'
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(f.name)) return 'Name must start with a letter and contain only letters, digits, underscores'
    if (!f.range.trim()) return 'Range is required'
    // Check uniqueness (excluding current edit).
    for (let i = 0; i < ranges.length; i++) {
      if (editIdx !== null && i === editIdx) continue
      if (ranges[i].name.toLowerCase() === f.name.toLowerCase()) return `Name "${f.name}" is already used`
    }
    return null
  }

  function save() {
    const err = validate(form)
    if (err) { setError(err); return }
    let next: NamedRangeEntry[]
    if (editIdx !== null) {
      next = ranges.map((r, i) => i === editIdx ? { ...form } : r)
    } else {
      next = [...ranges, { ...form }]
    }
    setRanges(next)
    setEditing(false)
    pushChange(next)
  }

  function remove(i: number) {
    const next = ranges.filter((_, idx) => idx !== i)
    setRanges(next)
    pushChange(next)
  }

  function pushChange(next: NamedRangeEntry[]) {
    if (!onChange) return
    const nextData = data.map((sheet, idx) =>
      idx === 0 ? { ...sheet, namedRanges: next } : sheet
    )
    onChange(nextData)
  }

  const inputCls = 'w-full rounded border border-line bg-bg px-2 py-1.5 text-xs text-ink focus:outline-none focus:border-line-strong'
  const selCls   = inputCls

  return (
    <div className="flex flex-col w-full sm:w-72 flex-shrink-0 h-full border-l border-line bg-paper overflow-y-auto">
      <div className="flex items-center justify-between px-3 py-2 border-b border-line">
        <span className="text-xs font-semibold text-ink tracking-tightish">Named ranges</span>
        <IconButton size="sm" title="Close" onClick={onClose}><X size={13} /></IconButton>
      </div>

      <div className="flex-1 px-3 py-3 space-y-3 text-xs overflow-y-auto">
        {!editing && (
          <>
            {ranges.length === 0 && (
              <p className="text-ink-faint">No named ranges. Add one to use in formulas like <code className="font-mono bg-bg px-1 rounded">SUM(myRange)</code>.</p>
            )}

            {ranges.map((r, i) => (
              <div key={i} className="flex items-start gap-2 border border-line rounded-md px-2 py-1.5">
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-ink truncate">{r.name}</p>
                  <p className="text-ink-faint text-[10px] truncate">{r.sheetName}!{r.range}</p>
                </div>
                <button onClick={() => copyRef(i)} aria-label={`Copy formula reference for ${r.name}`} title="Copy reference to use in a formula" className="text-ink-faint hover:text-ink mt-0.5 rounded-sm focus-visible:outline-none focus-visible:shadow-focus">
                  {copiedIdx === i ? <Check size={11} className="text-success" /> : <Copy size={11} />}
                </button>
                <button onClick={() => startEdit(i)} aria-label={`Edit named range ${r.name}`} className="text-ink-faint hover:text-ink mt-0.5 rounded-sm focus-visible:outline-none focus-visible:shadow-focus">
                  <Edit2 size={11} />
                </button>
                <button onClick={() => remove(i)} aria-label={`Delete named range ${r.name}`} className="text-ink-faint hover:text-danger mt-0.5 rounded-sm focus-visible:outline-none focus-visible:shadow-focus">
                  <Trash2 size={11} />
                </button>
              </div>
            ))}

            <Button variant="secondary" size="sm" onClick={startNew} className="w-full">
              <Plus size={11} className="mr-1" /> New named range
            </Button>
          </>
        )}

        {editing && (
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="block text-ink-muted font-medium">Name</label>
              <input
                value={form.name}
                onChange={(e) => { setForm((f) => ({ ...f, name: e.target.value })); setError('') }}
                className={inputCls}
                placeholder="e.g. myRange"
                autoFocus
              />
            </div>

            <div className="space-y-1">
              <label className="block text-ink-muted font-medium">Sheet</label>
              <select
                value={form.sheetName}
                onChange={(e) => setForm((f) => ({ ...f, sheetName: e.target.value }))}
                className={selCls}
              >
                {sheetNames.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>

            <div className="space-y-1">
              <label className="block text-ink-muted font-medium">Range</label>
              <input
                value={form.range}
                onChange={(e) => { setForm((f) => ({ ...f, range: e.target.value })); setError('') }}
                className={inputCls}
                placeholder="e.g. A1:B10"
              />
            </div>

            {error && <p className="text-danger text-[11px]">{error}</p>}

            <div className="flex gap-2">
              <Button variant="primary"   size="sm" onClick={save}              className="flex-1">Save</Button>
              <Button variant="secondary" size="sm" onClick={() => setEditing(false)} className="flex-1">Cancel</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
