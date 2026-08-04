/**
 * src/apps/sheets/ConditionalFormatPanel.tsx
 *
 * Conditional-formatting side panel — ONE rule builder for every kind:
 *   • single-colour rules  (greater than / text contains / date is before /
 *     is empty / duplicate values / custom formula …)
 *   • colour scales + data bars (gradient family)
 *
 * Every rule it writes is a plain, CLAMPED descriptor in `sheet.colorScales`
 * (colorScales.js), so it survives the CRDT merge, re-clamps on load, and is
 * re-clamped once more on the way to the canvas. The panel NEVER writes a raw
 * Fortune-Sheet rule: those are derived at render time from the clamped model.
 *
 * A file written by an older build may still carry raw native rules in
 * `luckysheet_conditionformat_save`; we list those under "Imported rules" so they
 * can be seen and removed, but we no longer create them.
 *
 * Props:
 *   data                {Sheet[]}  — workbook data
 *   onClose             {fn}
 *   onChange            {fn(data)} — workbook update (used for legacy-rule deletes)
 *   onColorScaleChange  {fn(data)} — authoritative rule write (insert/edit/delete)
 */
import { useMemo, useState } from 'react'
import { X, Plus, Trash2, Pencil, AlertCircle } from 'lucide-react'
import { Button, IconButton } from '../../components/ui'
import {
  getColorScales, insertColorScale, updateColorScale, deleteColorScale,
  makeColorScale, colorScaleSummary, colorScaleError, isSingleKind,
  CS_KIND_META, CS_SCALE_KINDS, CS_SINGLE_KINDS,
  type ColorScaleRule, type CSSheet, type NativeConditionFormat,
} from './colorScales.js'

/** A parsed A1-range `{ row: [r0,r1], column: [c0,c1] }` (0-indexed, inclusive). */
export interface ParsedRangeRect {
  row: [number, number]
  column: [number, number]
}

// Parse "A1:B10" style A1-notation range to Fortune Sheet conditionRange format.
// Supports:
//   "A1:Z100"  → { row: [0, 99], column: [0, 25] }  (0-indexed, inclusive)
//   "B2"       → { row: [1, 1],  column: [1, 1] }
// Column letters: A=0, Z=25, AA=26, AZ=51, BA=52, …
// Invalid input falls back to a sensible whole-sheet default.
export function colLetterToIndex(letters: string): number {
  const s = letters.toUpperCase()
  let idx = 0
  for (let i = 0; i < s.length; i++) {
    idx = idx * 26 + (s.charCodeAt(i) - 64)
  }
  return idx - 1  // 0-indexed
}

export function parseCellRef(ref: string): { col: number; row: number } | null {
  // ref like "A1", "BC200"
  const m = ref.match(/^([A-Za-z]+)(\d+)$/)
  if (!m) return null
  return {
    col: colLetterToIndex(m[1]),
    row: parseInt(m[2], 10) - 1,  // 0-indexed
  }
}

export function parseRange(text: string): ParsedRangeRect[] {
  const FALLBACK: ParsedRangeRect[] = [{ row: [0, 99], column: [0, 25] }]
  if (!text || text.trim() === '') return FALLBACK
  const parts = text.trim().toUpperCase().split(':')
  if (parts.length === 1) {
    // Single cell
    const cell = parseCellRef(parts[0])
    if (!cell) return FALLBACK
    return [{ row: [cell.row, cell.row], column: [cell.col, cell.col] }]
  }
  if (parts.length === 2) {
    const start = parseCellRef(parts[0])
    const end   = parseCellRef(parts[1])
    if (!start || !end) return FALLBACK
    return [{
      row:    [Math.min(start.row, end.row),    Math.max(start.row, end.row)],
      column: [Math.min(start.col, end.col),    Math.max(start.col, end.col)],
    }]
  }
  return FALLBACK
}

// Condition menu, grouped exactly as Sheets groups it.
const KIND_GROUPS = [
  { label: 'Cell value',   kinds: CS_SINGLE_KINDS.filter((k) => CS_KIND_META[k].group === 'value') },
  { label: 'Text',         kinds: CS_SINGLE_KINDS.filter((k) => CS_KIND_META[k].group === 'text') },
  { label: 'Date',         kinds: CS_SINGLE_KINDS.filter((k) => CS_KIND_META[k].group === 'date') },
  { label: 'Other',        kinds: CS_SINGLE_KINDS.filter((k) => CS_KIND_META[k].group === 'other') },
  { label: 'Scales & bars', kinds: CS_SCALE_KINDS },
]

interface EditRuleState {
  id: string | null
  kind: string
  range: string
  value1: string
  value2: string
  formula: string
  fill: string
  textColor: string
  min: string
  mid: string
  max: string
  barColor: string
}

const NEW_RULE: EditRuleState = {
  id: null,
  kind: 'greaterThan',
  range: 'A1:A10',
  value1: '',
  value2: '',
  formula: '',
  fill: '#fce8e6',
  textColor: '#b71c1c',
  min: '#f8696b',
  mid: '#ffeb84',
  max: '#63be7b',
  barColor: '#638ec6',
}

/** The colour chip shown next to a rule in the list. */
function RuleSwatch({ rule }: { rule: ColorScaleRule }) {
  const style = rule.kind === 'dataBar'
    ? { background: `linear-gradient(90deg, ${rule.barColor} 60%, transparent 60%)` }
    : rule.kind === 'colorScale2' || rule.kind === 'colorScale3'
      ? { background: `linear-gradient(90deg, ${rule.min}, ${rule.kind === 'colorScale3' ? `${rule.mid}, ` : ''}${rule.max})` }
      : { background: rule.fill, color: rule.textColor || undefined }
  return (
    <span
      aria-hidden
      className="w-6 h-4 rounded-sm border border-line flex-shrink-0 grid place-items-center text-[9px] font-semibold"
      style={style}
    >
      {isSingleKind(rule.kind) ? '123' : ''}
    </span>
  )
}

export interface ConditionalFormatPanelProps {
  data: CSSheet[]
  onClose: () => void
  onChange?: (data: CSSheet[]) => void
  onColorScaleChange?: (data: CSSheet[]) => void
}

export default function ConditionalFormatPanel({ data, onClose, onChange, onColorScaleChange }: ConditionalFormatPanelProps) {
  // Rule writes are authoritative overlay writes (a deletion must stick), so they
  // go through onColorScaleChange when provided, falling back to onChange.
  const pushRule = onColorScaleChange || onChange

  const rules = useMemo(() => getColorScales(data), [data])
  // Raw native rules from an older build (never created here any more).
  const legacy = useMemo(
    () => (data?.[0]?.luckysheet_conditionformat_save || []).filter((r) => !r?.__fromColorScale),
    [data],
  )

  const [edit, setEdit]   = useState<EditRuleState | null>(null) // the rule being added/edited
  const [error, setError] = useState('')

  const meta = edit ? CS_KIND_META[edit.kind] : null

  function startNew() { setEdit({ ...NEW_RULE }); setError('') }
  function startEdit(rule: ColorScaleRule) { setEdit({ ...rule }); setError('') }
  function patch(p: Partial<EditRuleState>) { setEdit((r) => (r ? { ...r, ...p } : r)); setError('') }

  function save() {
    if (!edit || !pushRule) return
    // Clamp FIRST, then validate what the clamp actually produced — the panel can
    // never save a rule the model would not accept.
    const clamped = makeColorScale({ ...edit, id: edit.id || undefined })
    const err = colorScaleError(clamped)
    if (err) { setError(err); return }
    pushRule(edit.id ? updateColorScale(data, edit.id, clamped) : insertColorScale(data, clamped))
    setEdit(null)
  }

  function remove(id: string) {
    if (!pushRule) return
    pushRule(deleteColorScale(data, id))
  }

  function removeLegacy(i: number) {
    if (!onChange) return
    const next = legacy.filter((_, idx) => idx !== i)
    onChange(data.map((sheet, idx) => (idx === 0 ? { ...sheet, luckysheet_conditionformat_save: next } : sheet)))
  }

  const inputCls = 'w-full rounded border border-line bg-bg px-2 py-1.5 text-xs text-ink focus:outline-none focus:border-line-strong'
  const selCls   = inputCls
  const swatchCls = 'h-6 w-10 rounded border border-line cursor-pointer focus-visible:outline-none focus-visible:shadow-focus'

  return (
    <div className="flex flex-col w-full sm:w-80 flex-shrink-0 h-full border-l border-line bg-paper overflow-y-auto">
      <div className="flex items-center justify-between px-3 py-2 border-b border-line">
        <span className="text-xs font-semibold text-ink tracking-tightish">Conditional formatting</span>
        <IconButton size="sm" title="Close" onClick={onClose}><X size={13} /></IconButton>
      </div>

      <div className="flex-1 px-3 py-3 space-y-3 text-xs overflow-y-auto">
        {/* ── Rule list ───────────────────────────────────────────────────── */}
        {edit === null && (
          <>
            {rules.length === 0 && (
              <p className="text-ink-faint">
                No rules yet. Highlight cells by value, text, date, emptiness or a formula —
                or add a colour scale that updates live with your data.
              </p>
            )}

            {rules.map((rule) => (
              <div key={rule.id} className="flex items-center gap-1.5 border border-line rounded-md px-2 py-1.5">
                <RuleSwatch rule={rule} />
                <span className="flex-1 min-w-0">
                  <span className="block truncate text-ink">{colorScaleSummary(rule)}</span>
                  <span className="block truncate text-ink-faint text-[10px]">{rule.range}</span>
                </span>
                <button
                  onClick={() => startEdit(rule)}
                  aria-label={`Edit rule: ${colorScaleSummary(rule)}`}
                  className="text-ink-faint hover:text-ink rounded-sm focus-visible:outline-none focus-visible:shadow-focus"
                ><Pencil size={11} /></button>
                <button
                  onClick={() => remove(rule.id)}
                  aria-label={`Delete rule: ${colorScaleSummary(rule)}`}
                  className="text-ink-faint hover:text-danger rounded-sm focus-visible:outline-none focus-visible:shadow-focus"
                ><Trash2 size={11} /></button>
              </div>
            ))}

            <Button variant="secondary" size="sm" onClick={startNew} className="w-full">
              <Plus size={11} className="mr-1" /> Add rule
            </Button>

            {rules.length > 1 && (
              <p className="text-ink-faint text-[10px]">Later rules win where two rules cover the same cell.</p>
            )}

            {legacy.length > 0 && (
              <div className="border-t border-line pt-3 space-y-2">
                <p className="font-medium text-ink-muted">Imported rules</p>
                {legacy.map((r: NativeConditionFormat, i) => (
                  <div key={i} className="flex items-center gap-1.5 border border-line rounded-md px-2 py-1.5">
                    <span
                      aria-hidden
                      className="w-4 h-4 rounded-sm border border-line flex-shrink-0"
                      style={{ background: r.format?.cellColor || 'transparent' }}
                    />
                    <span className="flex-1 truncate text-ink">
                      {r.conditionName} {(r as unknown as { conditionSymbol?: string }).conditionSymbol || ''} {String(r.conditionValue?.[0] ?? '')}
                    </span>
                    <button
                      onClick={() => removeLegacy(i)}
                      aria-label="Delete imported rule"
                      className="text-ink-faint hover:text-danger rounded-sm focus-visible:outline-none focus-visible:shadow-focus"
                    ><Trash2 size={11} /></button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* ── Rule editor ─────────────────────────────────────────────────── */}
        {edit !== null && meta && (
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="block text-ink-muted font-medium" htmlFor="cf-range">Apply to range</label>
              <input
                id="cf-range"
                value={edit.range}
                onChange={(e) => patch({ range: e.target.value })}
                className={inputCls}
                placeholder="e.g. A1:A20"
                autoFocus
              />
            </div>

            <div className="space-y-1">
              <label className="block text-ink-muted font-medium" htmlFor="cf-kind">Format cells if…</label>
              <select
                id="cf-kind"
                value={edit.kind}
                onChange={(e) => patch({ kind: e.target.value })}
                className={selCls}
              >
                {KIND_GROUPS.map((g) => (
                  <optgroup key={g.label} label={g.label}>
                    {g.kinds.map((k) => <option key={k} value={k}>{CS_KIND_META[k].label}</option>)}
                  </optgroup>
                ))}
              </select>
            </div>

            {/* Operands */}
            {meta.input === 'formula' && (
              <div className="space-y-1">
                <label className="block text-ink-muted font-medium" htmlFor="cf-formula">Custom formula</label>
                <input
                  id="cf-formula"
                  value={edit.formula}
                  onChange={(e) => patch({ formula: e.target.value })}
                  className={`${inputCls} font-mono`}
                  placeholder="=$A1>10"
                  spellCheck={false}
                />
                <p className="text-ink-faint text-[10px]">
                  Relative to the first cell of the range. Use $ to anchor a row or column.
                </p>
              </div>
            )}

            {meta.args >= 1 && meta.input !== 'formula' && (
              <div className="flex gap-2">
                <div className="flex-1 space-y-1">
                  <label className="block text-ink-muted font-medium" htmlFor="cf-value1">
                    {meta.args === 2 ? 'From' : 'Value'}
                  </label>
                  <input
                    id="cf-value1"
                    type={meta.input === 'date' ? 'date' : 'text'}
                    inputMode={meta.input === 'number' ? 'decimal' : undefined}
                    value={edit.value1}
                    onChange={(e) => patch({ value1: e.target.value })}
                    className={inputCls}
                    placeholder={meta.input === 'number' ? '10' : 'Value'}
                  />
                </div>
                {meta.args === 2 && (
                  <div className="flex-1 space-y-1">
                    <label className="block text-ink-muted font-medium" htmlFor="cf-value2">To</label>
                    <input
                      id="cf-value2"
                      type={meta.input === 'date' ? 'date' : 'text'}
                      inputMode={meta.input === 'number' ? 'decimal' : undefined}
                      value={edit.value2}
                      onChange={(e) => patch({ value2: e.target.value })}
                      className={inputCls}
                      placeholder={meta.input === 'number' ? '20' : 'Value'}
                    />
                  </div>
                )}
              </div>
            )}

            {/* Formatting style */}
            <div className="space-y-2 border-t border-line pt-2">
              <p className="font-medium text-ink-muted">Formatting style</p>

              {isSingleKind(edit.kind) ? (
                <>
                  <div className="flex items-center gap-2">
                    <label className="text-ink-muted w-20" htmlFor="cf-fill">Fill</label>
                    <input
                      id="cf-fill" type="color" value={edit.fill}
                      onChange={(e) => patch({ fill: e.target.value })}
                      className={swatchCls}
                    />
                    <span
                      className="flex-1 rounded border border-line px-2 py-1 text-center truncate"
                      style={{ background: edit.fill, color: edit.textColor || 'inherit' }}
                    >
                      123
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-ink-muted w-20" htmlFor="cf-text">Text color</label>
                    <input
                      id="cf-text" type="color" value={edit.textColor || '#000000'}
                      onChange={(e) => patch({ textColor: e.target.value })}
                      className={swatchCls}
                    />
                    {edit.textColor !== '' && (
                      <button
                        onClick={() => patch({ textColor: '' })}
                        className="text-ink-faint hover:text-ink underline rounded-sm focus-visible:outline-none focus-visible:shadow-focus"
                      >
                        Keep original
                      </button>
                    )}
                  </div>
                </>
              ) : edit.kind === 'dataBar' ? (
                <div className="flex items-center gap-2">
                  <label className="text-ink-muted w-20" htmlFor="cf-bar">Bar color</label>
                  <input
                    id="cf-bar" type="color" value={edit.barColor}
                    onChange={(e) => patch({ barColor: e.target.value })}
                    className={swatchCls}
                  />
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <label className="text-ink-muted w-20" htmlFor="cf-min">Min color</label>
                    <input
                      id="cf-min" type="color" value={edit.min}
                      onChange={(e) => patch({ min: e.target.value })}
                      className={swatchCls}
                    />
                  </div>
                  {edit.kind === 'colorScale3' && (
                    <div className="flex items-center gap-2">
                      <label className="text-ink-muted w-20" htmlFor="cf-mid">Mid color</label>
                      <input
                        id="cf-mid" type="color" value={edit.mid}
                        onChange={(e) => patch({ mid: e.target.value })}
                        className={swatchCls}
                      />
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <label className="text-ink-muted w-20" htmlFor="cf-max">Max color</label>
                    <input
                      id="cf-max" type="color" value={edit.max}
                      onChange={(e) => patch({ max: e.target.value })}
                      className={swatchCls}
                    />
                  </div>
                </>
              )}
            </div>

            {error && (
              <p className="flex items-start gap-1 text-danger text-[11px]" role="alert">
                <AlertCircle size={12} className="mt-px flex-shrink-0" aria-hidden /> {error}
              </p>
            )}

            <div className="flex gap-2">
              <Button variant="primary"   size="sm" onClick={save}              className="flex-1">Save</Button>
              <Button variant="secondary" size="sm" onClick={() => setEdit(null)} className="flex-1">Cancel</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
