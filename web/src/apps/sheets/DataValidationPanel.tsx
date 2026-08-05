/**
 * src/apps/sheets/DataValidationPanel.tsx
 *
 * Data-validation side panel: dropdown lists (literal or from a range, including
 * another sheet), checkboxes, number ranges, dates, and text content/length.
 * Rules are written to Fortune Sheet's native `sheet.dataVerification` map, so
 * the grid renders the dropdown chevron + enforces invalid-entry rejection with
 * no extra wiring. Pure rule logic lives in ./dataValidation.js (unit-tested);
 * this file is just the form — and it can only save what buildRegulation accepts,
 * so a half-formed rule surfaces an error instead of writing junk.
 *
 * Props:
 *   data       {Sheet[]}   — workbook data
 *   activeCell {{row,col}} — current selection, used to prefill the range
 *   onClose    {fn}
 *   onChange   {fn(data)}  — called with the updated workbook after a change
 */
import { useMemo, useState } from 'react'
import { X, Plus, Trash2, ListChecks, AlertCircle } from 'lucide-react'
import { Button, IconButton } from '../../components/ui'
import { parseRange } from './ConditionalFormatPanel.jsx'
import {
  VALIDATION_KINDS,
  NUMBER_CONDITIONS,
  DATE_CONDITIONS,
  TEXT_CONDITIONS,
  numberConditionArity,
  dateConditionArity,
  buildRegulation,
  applyValidation,
  listValidationRules,
  type ConditionMeta,
  type DVSheet,
} from './dataValidation.js'

interface ActiveCell { row: number; col: number }

export interface DataValidationPanelProps {
  data: DVSheet[]
  activeCell?: ActiveCell | null
  onClose: () => void
  onChange?: (data: DVSheet[]) => void
}

interface DVForm {
  kind: string
  items: string
  sourceRange: string
  allowMulti: boolean
  checkedValue: string
  uncheckedValue: string
  condition: string
  value1: string
  value2: string
  rejectInvalid: boolean
  hint: string
}

function colLetter(col: number): string {
  let s = ''
  let n = col
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1 } while (n >= 0)
  return s
}
function cellA1(row: number, col: number): string { return `${colLetter(col)}${row + 1}` }

// parseRange (ConditionalFormatPanel.jsx, not yet converted) infers a `number[]`
// row/column shape rather than the `[number, number]` tuple applyValidation's
// signature declares — a local, typed adapter over the same runtime contract.
const parseRangeTyped = (text: string): { row: [number, number]; column: [number, number] }[] | undefined =>
  parseRange(text) as { row: [number, number]; column: [number, number] }[] | undefined

const EMPTY_FORM: DVForm = {
  kind: 'dropdown',
  items: '',
  sourceRange: '',
  allowMulti: false,
  checkedValue: 'TRUE',
  uncheckedValue: 'FALSE',
  condition: 'between',
  value1: '',
  value2: '',
  rejectInvalid: true,
  hint: '',
}

interface ConditionGroup {
  list: ConditionMeta[]
  arity: (v: unknown) => number
  input: string
  default: string
}

// The condition list + arity for each kind that has one.
const CONDITIONS: Record<string, ConditionGroup> = {
  number:     { list: NUMBER_CONDITIONS, arity: numberConditionArity, input: 'decimal', default: 'between' },
  textLength: { list: NUMBER_CONDITIONS, arity: numberConditionArity, input: 'numeric', default: 'between' },
  date:       { list: DATE_CONDITIONS,   arity: dateConditionArity,   input: 'date',    default: 'between' },
  text:       { list: TEXT_CONDITIONS,   arity: () => 1,              input: 'text',    default: 'include' },
}

// The message shown when buildRegulation refuses the form.
const KIND_ERROR: Record<string, string> = {
  dropdown:      'Add at least one dropdown item (comma-separated).',
  dropdownRange: 'Enter a valid source range, e.g. Sheet2!A1:A10.',
  checkbox:      'Give the checkbox two different values.',
  number:        'Enter valid numeric value(s) for the condition.',
  date:          'Enter valid date(s), e.g. 2026-07-14.',
  text:          'Enter the text to match.',
  textLength:    'Enter a whole-number length for the condition.',
}

export default function DataValidationPanel({ data, activeCell, onClose, onChange }: DataValidationPanelProps) {
  const sheet = data?.[0]
  const rules = useMemo(() => listValidationRules(sheet), [sheet])

  const defaultRange = activeCell
    ? cellA1(activeCell.row, activeCell.col)
    : 'A1'
  const [editing, setEditing] = useState(false)
  const [range, setRange]     = useState(defaultRange)
  const [form, setForm]       = useState<DVForm>(EMPTY_FORM)
  const [error, setError]     = useState('')

  const inputCls = 'w-full rounded border border-line bg-bg px-2 py-1.5 text-xs text-ink focus:outline-none focus:border-line-strong'
  const selCls   = inputCls

  const cond  = CONDITIONS[form.kind]
  const arity = cond ? cond.arity(form.condition) : 0

  function startNew() {
    setForm(EMPTY_FORM)
    setRange(defaultRange)
    setError('')
    setEditing(true)
  }

  function patch(p: Partial<DVForm>) { setForm((f) => ({ ...f, ...p })); setError('') }

  // Switching criteria resets the condition to one the new kind actually has
  // (a `date` rule must never carry over a `moreThanThe` from the number list).
  function changeKind(kind: string) {
    const next = CONDITIONS[kind]
    patch({ kind, condition: next ? next.default : EMPTY_FORM.condition, value1: '', value2: '' })
  }

  function save() {
    const reg = buildRegulation(form)
    if (!reg) {
      setError(KIND_ERROR[form.kind] || 'Complete the rule before saving.')
      return
    }
    const parsed = parseRange(range)?.[0]
    if (!parsed) { setError('Enter a valid range, e.g. A1:A10.'); return }
    const next = applyValidation(data, range, reg, parseRangeTyped)
    onChange?.(next)
    setEditing(false)
  }

  function removeRule(keys: string[]) {
    // Clear every cell key this rule covers.
    let next = data
    for (const key of keys) {
      const [r, c] = key.split('_').map(Number)
      next = applyValidation(next, cellA1(r, c), null, parseRangeTyped)
    }
    onChange?.(next)
  }

  return (
    <div className="flex flex-col w-full sm:w-80 flex-shrink-0 h-full border-l border-line bg-paper overflow-y-auto">
      <div className="flex items-center justify-between px-3 py-2 border-b border-line">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink tracking-tightish">
          <ListChecks size={13} aria-hidden /> Data validation
        </span>
        <IconButton size="sm" title="Close" onClick={onClose}><X size={13} /></IconButton>
      </div>

      <div className="flex-1 px-3 py-3 space-y-3 text-xs overflow-y-auto">
        {!editing && (
          <>
            {rules.length === 0 && (
              <p className="text-ink-faint">
                No validation rules. Add one to give cells a dropdown list, a checkbox,
                or to restrict them to a number, a date, or text of a given shape.
              </p>
            )}

            {rules.map((rule, i) => (
              <div key={i} className="flex items-start gap-2 border border-line rounded-md px-2 py-1.5">
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-ink truncate">{rule.summary}</p>
                  <p className="text-ink-faint text-[10px]">
                    {rule.count} cell{rule.count === 1 ? '' : 's'}
                    {rule.reg?.prohibitInput ? ' · rejects invalid input' : ''}
                  </p>
                </div>
                <button
                  onClick={() => removeRule(rule.keys)}
                  aria-label={`Remove validation rule: ${rule.summary}`}
                  className="text-ink-faint hover:text-danger mt-0.5 rounded-sm focus-visible:outline-none focus-visible:shadow-focus"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))}

            <Button variant="secondary" size="sm" onClick={startNew} className="w-full">
              <Plus size={11} className="mr-1" /> Add rule
            </Button>
          </>
        )}

        {editing && (
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="block text-ink-muted font-medium" htmlFor="dv-range">Apply to range</label>
              <input
                id="dv-range"
                value={range}
                onChange={(e) => { setRange(e.target.value); setError('') }}
                className={inputCls}
                placeholder="e.g. A1:A10"
                autoFocus
              />
            </div>

            <div className="space-y-1">
              <label className="block text-ink-muted font-medium" htmlFor="dv-kind">Criteria</label>
              <select
                id="dv-kind"
                value={form.kind}
                onChange={(e) => changeKind(e.target.value)}
                className={selCls}
              >
                {VALIDATION_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
              </select>
            </div>

            {form.kind === 'dropdown' && (
              <>
                <div className="space-y-1">
                  <label className="block text-ink-muted font-medium" htmlFor="dv-items">Items (comma-separated)</label>
                  <input
                    id="dv-items"
                    value={form.items}
                    onChange={(e) => patch({ items: e.target.value })}
                    className={inputCls}
                    placeholder="e.g. Low, Medium, High"
                  />
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.allowMulti}
                    onChange={(e) => patch({ allowMulti: e.target.checked })}
                  />
                  <span className="text-ink-muted">Allow multiple selection</span>
                </label>
              </>
            )}

            {form.kind === 'dropdownRange' && (
              <>
                <div className="space-y-1">
                  <label className="block text-ink-muted font-medium" htmlFor="dv-source">List source range</label>
                  <input
                    id="dv-source"
                    value={form.sourceRange}
                    onChange={(e) => patch({ sourceRange: e.target.value })}
                    className={inputCls}
                    placeholder="e.g. Sheet2!A1:A10"
                  />
                  <p className="text-ink-faint text-[10px]">
                    The list follows the cells — edit the source and every dropdown updates.
                  </p>
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.allowMulti}
                    onChange={(e) => patch({ allowMulti: e.target.checked })}
                  />
                  <span className="text-ink-muted">Allow multiple selection</span>
                </label>
              </>
            )}

            {form.kind === 'checkbox' && (
              <div className="flex gap-2">
                <div className="flex-1 space-y-1">
                  <label className="block text-ink-muted font-medium" htmlFor="dv-checked">Checked value</label>
                  <input
                    id="dv-checked"
                    value={form.checkedValue}
                    onChange={(e) => patch({ checkedValue: e.target.value })}
                    className={inputCls}
                  />
                </div>
                <div className="flex-1 space-y-1">
                  <label className="block text-ink-muted font-medium" htmlFor="dv-unchecked">Unchecked value</label>
                  <input
                    id="dv-unchecked"
                    value={form.uncheckedValue}
                    onChange={(e) => patch({ uncheckedValue: e.target.value })}
                    className={inputCls}
                  />
                </div>
              </div>
            )}

            {cond && (
              <>
                <div className="space-y-1">
                  <label className="block text-ink-muted font-medium" htmlFor="dv-cond">Condition</label>
                  <select
                    id="dv-cond"
                    value={form.condition}
                    onChange={(e) => patch({ condition: e.target.value })}
                    className={selCls}
                  >
                    {cond.list.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                </div>
                <div className="flex gap-2">
                  <input
                    aria-label="Value"
                    type={cond.input === 'date' ? 'date' : 'text'}
                    inputMode={cond.input === 'date' || cond.input === 'text' ? undefined : (cond.input as React.HTMLAttributes<HTMLInputElement>['inputMode'])}
                    value={form.value1}
                    onChange={(e) => patch({ value1: e.target.value })}
                    className={inputCls}
                    placeholder={form.kind === 'textLength' ? 'Length' : 'Value'}
                  />
                  {arity === 2 && (
                    <input
                      aria-label="Upper value"
                      type={cond.input === 'date' ? 'date' : 'text'}
                      inputMode={cond.input === 'date' || cond.input === 'text' ? undefined : (cond.input as React.HTMLAttributes<HTMLInputElement>['inputMode'])}
                      value={form.value2}
                      onChange={(e) => patch({ value2: e.target.value })}
                      className={inputCls}
                      placeholder="and"
                    />
                  )}
                </div>
              </>
            )}

            <label className="flex items-center gap-2 cursor-pointer border-t border-line pt-2">
              <input
                type="checkbox"
                checked={form.rejectInvalid}
                onChange={(e) => patch({ rejectInvalid: e.target.checked })}
                disabled={form.kind === 'checkbox'}
              />
              <span className="text-ink-muted">Reject invalid input</span>
            </label>

            {error && (
              <p className="flex items-start gap-1 text-danger text-[11px]" role="alert">
                <AlertCircle size={12} className="mt-px flex-shrink-0" aria-hidden /> {error}
              </p>
            )}

            <div className="flex gap-2">
              <Button variant="primary"   size="sm" onClick={save}                 className="flex-1">Save</Button>
              <Button variant="secondary" size="sm" onClick={() => setEditing(false)} className="flex-1">Cancel</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
