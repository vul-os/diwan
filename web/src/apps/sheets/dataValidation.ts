/**
 * src/apps/sheets/dataValidation.ts
 *
 * Pure helpers for per-cell data validation (dropdown lists — literal or from a
 * range —, numbers, dates, text content/length and checkboxes), backed by
 * Fortune Sheet's native `sheet.dataVerification` map.
 *
 * Fortune Sheet stores validation per sheet as an object keyed by "row_col"
 * (0-indexed), whose values follow its DataRegulationProps shape. When present
 * the library renders the dropdown affordance and enforces `prohibitInput`
 * automatically — so we only have to produce well-formed rule objects and merge
 * them into the sheet. We deliberately do NOT touch cell values here, so this
 * feature never interferes with the CRDT grid-sync path (which tracks cell
 * strings, not this metadata).
 *
 * SECURITY: buildRegulation is a FAIL-CLOSED builder — it returns null (and the
 * panel surfaces an error) rather than write a half-formed rule, and every field
 * it emits is an allow-listed token, a bounded string, or a validated number/
 * date/A1-range. clampDataValidation re-applies that same clamp to every stored
 * regulation on load, so a corrupt/legacy/hostile `dataVerification` map from an
 * untrusted file can never reach Fortune-Sheet's validator or its hint box.
 */
import type { DataRegulationProps } from '@fortune-sheet/core'

/** Fortune Sheet's own `DataRegulationProps` plus our `checkbox` marker, which
 * lets a two-value dropdown round-trip back into the panel's checkbox form. */
export interface Regulation extends DataRegulationProps {
  checkbox?: boolean
}

/** Loose, pre-validation form the panel edits and buildRegulation clamps. Any
 * field may arrive as anything (a corrupt file, a hostile peer op, a half-typed
 * form) — every accessor below coerces/validates before it is trusted. */
export interface ValidationForm {
  kind?: unknown
  rejectInvalid?: unknown
  hint?: unknown
  allowMulti?: unknown
  items?: unknown
  sourceRange?: unknown
  checkedValue?: unknown
  uncheckedValue?: unknown
  condition?: unknown
  value1?: unknown
  value2?: unknown
}

export interface DVSheet {
  dataVerification?: Record<string, unknown>
  [key: string]: unknown
}

export interface ValidationRuleGroup {
  reg: Regulation
  keys: string[]
  summary: string
  count: number
}

export interface ConditionMeta { value: string; label: string; needs: number }

// Human-facing rule kinds → the native `type` / `type2` pair Fortune Sheet uses
// in validateCellData(). We keep the surface small and Sheets-like.
export const VALIDATION_KINDS = [
  { value: 'dropdown',      label: 'Dropdown (list of items)' },
  { value: 'dropdownRange', label: 'Dropdown (list from a range)' },
  { value: 'checkbox',      label: 'Checkbox' },
  { value: 'number',        label: 'Number' },
  { value: 'date',          label: 'Date' },
  { value: 'text',          label: 'Text' },
  { value: 'textLength',    label: 'Text length' },
]

// number sub-conditions → native type2 tokens.
export const NUMBER_CONDITIONS: ConditionMeta[] = [
  { value: 'between',            label: 'between',                 needs: 2 },
  { value: 'notBetween',         label: 'not between',             needs: 2 },
  { value: 'equal',              label: 'is equal to',             needs: 1 },
  { value: 'notEqualTo',         label: 'is not equal to',         needs: 1 },
  { value: 'moreThanThe',        label: 'greater than',            needs: 1 },
  { value: 'lessThan',           label: 'less than',               needs: 1 },
  { value: 'greaterOrEqualTo',   label: 'greater than or equal',   needs: 1 },
  { value: 'lessThanOrEqualTo',  label: 'less than or equal',      needs: 1 },
]

// date sub-conditions → native type2 tokens (Fortune-Sheet compares with dayjs).
export const DATE_CONDITIONS: ConditionMeta[] = [
  { value: 'between',        label: 'between',        needs: 2 },
  { value: 'notBetween',     label: 'not between',    needs: 2 },
  { value: 'equal',          label: 'is',             needs: 1 },
  { value: 'notEqualTo',     label: 'is not',         needs: 1 },
  { value: 'earlierThan',    label: 'is before',      needs: 1 },
  { value: 'noEarlierThan',  label: 'is on or after', needs: 1 },
  { value: 'laterThan',      label: 'is after',       needs: 1 },
  { value: 'noLaterThan',    label: 'is on or before', needs: 1 },
]

// text-content sub-conditions → native type2 tokens (native type 'text_content').
export const TEXT_CONDITIONS: ConditionMeta[] = [
  { value: 'include', label: 'contains',        needs: 1 },
  { value: 'exclude', label: 'does not contain', needs: 1 },
  { value: 'equal',   label: 'is exactly',      needs: 1 },
]

const NUMBER_SET = new Set(NUMBER_CONDITIONS.map((c) => c.value))
const DATE_SET   = new Set(DATE_CONDITIONS.map((c) => c.value))
const TEXT_SET   = new Set(TEXT_CONDITIONS.map((c) => c.value))

// Native `type` values we are willing to store/render. Anything else in a loaded
// file is dropped by clampDataValidation (fail-closed) — including Fortune-Sheet's
// locale-specific `validity` rules (Chinese ID card / phone), which we never emit.
const NATIVE_TYPES = new Set([
  'dropdown', 'number', 'number_integer', 'number_decimal',
  'text_content', 'text_length', 'date',
])

// Bounds on every string we let into the model (a hint is rendered in FS's hint
// box; a dropdown list is rendered as a menu — neither may be unbounded).
const MAX_ITEMS      = 200
const MAX_ITEMS_LEN  = 2000
const MAX_ITEM_LEN   = 120
const MAX_HINT_LEN   = 200
const MAX_VALUE_LEN  = 60

// An A1 range (optionally sheet-qualified: `Sheet2!A1:A10`) — the exact shape
// Fortune-Sheet's iscelldata()/getcellrange() accept as a dropdown list source.
const RANGE_RE = /^(?:(?:'[^'!]{1,64}'|[A-Za-z0-9_ ]{1,64})!)?\$?[A-Za-z]{1,3}\$?\d{1,7}(?::\$?[A-Za-z]{1,3}\$?\d{1,7})?$/
// A calendar date, as Fortune-Sheet's dayjs comparison expects it.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function numberConditionArity(type2: unknown): number {
  const c = NUMBER_CONDITIONS.find((x) => x.value === type2)
  return c ? c.needs : 1
}

export function dateConditionArity(type2: unknown): number {
  const c = DATE_CONDITIONS.find((x) => x.value === type2)
  return c ? c.needs : 1
}

/** validationRange — a validated dropdown-source range, or '' when unusable. */
export function validationRange(text: unknown): string {
  const s = (typeof text === 'string' ? text : '').trim()
  if (!s || s.length > 80 || !RANGE_RE.test(s)) return ''
  return s
}

/** validationDate — a validated ISO calendar date, or '' when unusable. */
export function validationDate(text: unknown): string {
  const s = (typeof text === 'string' ? text : '').trim()
  if (!DATE_RE.test(s)) return ''
  const [y, m, d] = s.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return ''
  return s
}

/** Bounded, control-char-free coercion of any untrusted rule string. */
function safeStr(v: unknown, max: number): string {
  if (typeof v === 'number' && isFinite(v)) return String(v).slice(0, max)
  if (typeof v !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\x00-\x1f\x7f]/g, '').slice(0, max)
}

/**
 * dropdownItems — split a comma-separated option string into a clean list.
 * Mirrors how Fortune Sheet's getDropdownList treats a literal (non-range)
 * value1: trims, drops empties, de-duplicates while preserving order. Bounded:
 * a hostile list can't blow up the menu it renders into.
 */
export function dropdownItems(value1: unknown): string[] {
  if (!value1) return []
  const seen = new Set<string>()
  const out: string[] = []
  const value1Str = typeof value1 === 'string' || typeof value1 === 'number' ? String(value1) : ''
  for (const raw of value1Str.split(',')) {
    const item = safeStr(raw, MAX_ITEM_LEN).trim()
    if (!item || seen.has(item)) continue
    seen.add(item)
    out.push(item)
    if (out.length >= MAX_ITEMS) break
  }
  return out
}

/** The two labels a checkbox rule accepts, defaulting to TRUE / FALSE. */
export function checkboxValues(form: ValidationForm | null | undefined): [string, string] | null {
  const on  = safeStr(form?.checkedValue,   MAX_VALUE_LEN).trim() || 'TRUE'
  const off = safeStr(form?.uncheckedValue, MAX_VALUE_LEN).trim() || 'FALSE'
  return on === off ? null : [on, off]
}

// Shared tail of every regulation: the fields Fortune-Sheet reads besides the
// condition itself. `hintValue` is rendered by FS's hint box, so it is bounded.
function tail(form: ValidationForm): Pick<Regulation, 'validity' | 'remote' | 'prohibitInput' | 'hintShow' | 'hintValue'> {
  const hint = safeStr(form?.hint, MAX_HINT_LEN)
  return {
    validity: '',
    remote: false,
    prohibitInput: !!form?.rejectInvalid,
    hintShow: !!hint,
    hintValue: hint,
  }
}

/**
 * buildRegulation — produce a native DataRegulationProps object from our
 * simplified form. Returns null when the form can't yield a usable rule (so the
 * caller can surface a validation error rather than write junk) — the fail-closed
 * gate every rule kind goes through, whether it comes from the panel or a load.
 */
export function buildRegulation(form: ValidationForm | null | undefined): Regulation | null {
  if (!form) return null

  if (form.kind === 'dropdown') {
    const items = dropdownItems(form.items)
    if (items.length === 0) return null
    return {
      type: 'dropdown',
      type2: form.allowMulti ? 'true' : '',
      rangeTxt: '',
      value1: items.join(',').slice(0, MAX_ITEMS_LEN),
      value2: '',
      ...tail(form),
    }
  }

  // A dropdown whose items come from a RANGE (incl. another sheet: `Sheet2!A1:A9`).
  // Fortune-Sheet's getDropdownList() reads the live cells whenever value1 parses
  // as a range (iscelldata) — so the list stays in sync with its source.
  if (form.kind === 'dropdownRange') {
    const range = validationRange(form.sourceRange)
    if (!range) return null
    return {
      type: 'dropdown',
      type2: form.allowMulti ? 'true' : '',
      rangeTxt: '',
      value1: range,
      value2: '',
      ...tail(form),
    }
  }

  // Fortune-Sheet HAS a native `checkbox` regulation, but it is inert: it draws a
  // box, blocks the cell editor, and nothing ever sets its `checked` flag — you
  // get a checkbox you cannot tick. So a checkbox here is a two-value dropdown
  // (TRUE/FALSE by default), which is a real, working control: pick a value, and
  // formulas can test it. `checkbox: true` is our own marker so the panel can
  // round-trip the rule back into the checkbox form.
  if (form.kind === 'checkbox') {
    const vals = checkboxValues(form)
    if (!vals) return null
    return {
      type: 'dropdown',
      type2: '',
      rangeTxt: '',
      value1: vals.join(','),
      value2: '',
      checkbox: true,
      ...tail(form),
      prohibitInput: true, // a checkbox cell only ever holds one of its two values
    }
  }

  if (form.kind === 'number') {
    if (!NUMBER_SET.has(form.condition as string)) return null
    const needs = numberConditionArity(form.condition)
    const v1 = safeStr(form.value1, MAX_VALUE_LEN).trim()
    const v2 = safeStr(form.value2, MAX_VALUE_LEN).trim()
    if (v1 === '' || !isFinite(Number(v1))) return null
    if (needs === 2 && (v2 === '' || !isFinite(Number(v2)))) return null
    return {
      type: 'number',
      type2: form.condition as string,
      rangeTxt: '',
      value1: v1,
      value2: needs === 2 ? v2 : '',
      ...tail(form),
    }
  }

  if (form.kind === 'date') {
    if (!DATE_SET.has(form.condition as string)) return null
    const needs = dateConditionArity(form.condition)
    const v1 = validationDate(form.value1)
    const v2 = validationDate(form.value2)
    if (!v1) return null
    if (needs === 2 && !v2) return null
    return {
      type: 'date',
      type2: form.condition as string,
      rangeTxt: '',
      value1: v1,
      value2: needs === 2 ? v2 : '',
      ...tail(form),
    }
  }

  if (form.kind === 'text') {
    if (!TEXT_SET.has(form.condition as string)) return null
    const v1 = safeStr(form.value1, MAX_VALUE_LEN)
    if (v1.trim() === '') return null
    return {
      type: 'text_content',
      type2: form.condition as string,
      rangeTxt: '',
      value1: v1,
      value2: '',
      ...tail(form),
    }
  }

  if (form.kind === 'textLength') {
    if (!NUMBER_SET.has(form.condition as string)) return null
    const needs = numberConditionArity(form.condition)
    const v1 = safeStr(form.value1, MAX_VALUE_LEN).trim()
    const v2 = safeStr(form.value2, MAX_VALUE_LEN).trim()
    const lenOk = (v: string) => v !== '' && /^\d{1,6}$/.test(v)
    if (!lenOk(v1)) return null
    if (needs === 2 && !lenOk(v2)) return null
    return {
      type: 'text_length',
      type2: form.condition as string,
      rangeTxt: '',
      value1: v1,
      value2: needs === 2 ? v2 : '',
      ...tail(form),
    }
  }

  return null
}

/**
 * regulationToForm — reverse-map a stored regulation into the panel's form shape
 * (the round-trip that lets a saved rule be re-opened and edited).
 */
export function regulationToForm(reg: Regulation | null | undefined): ValidationForm | null {
  if (!reg) return null
  const base: ValidationForm = {
    rejectInvalid: !!reg.prohibitInput,
    hint: reg.hintValue || '',
    allowMulti: reg.type2 === 'true',
  }
  if (reg.type === 'dropdown') {
    if (reg.checkbox) {
      const [on, off] = dropdownItems(reg.value1)
      return { ...base, kind: 'checkbox', checkedValue: on || 'TRUE', uncheckedValue: off || 'FALSE' }
    }
    if (validationRange(reg.value1)) {
      return { ...base, kind: 'dropdownRange', sourceRange: reg.value1 }
    }
    return { ...base, kind: 'dropdown', items: reg.value1 || '' }
  }
  if (reg.type === 'number' || reg.type === 'number_integer' || reg.type === 'number_decimal') {
    return { ...base, kind: 'number', condition: reg.type2, value1: reg.value1 || '', value2: reg.value2 || '' }
  }
  if (reg.type === 'date') {
    return { ...base, kind: 'date', condition: reg.type2, value1: reg.value1 || '', value2: reg.value2 || '' }
  }
  if (reg.type === 'text_content') {
    return { ...base, kind: 'text', condition: reg.type2, value1: reg.value1 || '' }
  }
  if (reg.type === 'text_length') {
    return { ...base, kind: 'textLength', condition: reg.type2, value1: reg.value1 || '', value2: reg.value2 || '' }
  }
  return null
}

/**
 * clampRegulation — the fail-closed INGRESS clamp for one stored regulation.
 * A regulation loaded from an untrusted origin (server file, XLSX import, draft,
 * legacy record) is reverse-mapped into our form shape and REBUILT through
 * buildRegulation — so it can only survive as a rule we would have written
 * ourselves: allow-listed type/type2, bounded strings, validated numbers, dates
 * and ranges. Anything else (unknown type, junk condition, 10 MB hint) → null,
 * and the caller drops the cell's rule entirely.
 */
export function clampRegulation(reg: unknown): Regulation | null {
  if (!reg || typeof reg !== 'object' || Array.isArray(reg)) return null
  const r = reg as Record<string, unknown>
  if (!NATIVE_TYPES.has(r.type as string)) return null
  const form = regulationToForm({
    ...(r as unknown as Regulation),
    value1: safeStr(r.value1, MAX_ITEMS_LEN),
    value2: safeStr(r.value2, MAX_VALUE_LEN),
    hintValue: safeStr(r.hintValue, MAX_HINT_LEN),
    checkbox: r.checkbox === true,
  })
  if (!form) return null
  return buildRegulation(form)
}

/**
 * clampDataValidation — run every stored regulation on every sheet through the
 * ingress clamp, dropping the ones that don't survive. Wired into the editor's
 * single loadContent() gate, alongside clampCharts / clampPivots / clampColorScales.
 */
export function clampDataValidation(data: DVSheet[] | null | undefined): DVSheet[] {
  return (data || []).map((sheet) => {
    const dv = sheet?.dataVerification
    if (!dv || typeof dv !== 'object') return sheet
    const next: Record<string, Regulation> = {}
    for (const [key, reg] of Object.entries(dv)) {
      if (!/^\d{1,7}_\d{1,7}$/.test(key)) continue // only well-formed "row_col" keys
      const safe = clampRegulation(reg)
      if (safe) next[key] = safe
    }
    return { ...sheet, dataVerification: next }
  })
}

/**
 * validationSummary — one-line human description of a stored regulation, for
 * the rule list. Never throws on partial data.
 */
export function validationSummary(reg: Regulation | null | undefined): string {
  if (!reg) return ''
  if (reg.type === 'dropdown') {
    if (reg.checkbox) {
      const [on, off] = dropdownItems(reg.value1)
      return `Checkbox · ${on || 'TRUE'} / ${off || 'FALSE'}`
    }
    if (validationRange(reg.value1)) {
      return `Dropdown · from ${reg.value1}${reg.type2 === 'true' ? ' · multi' : ''}`
    }
    const n = dropdownItems(reg.value1).length
    return `Dropdown · ${n} item${n === 1 ? '' : 's'}${reg.type2 === 'true' ? ' · multi' : ''}`
  }
  if (reg.type === 'number' || reg.type === 'number_integer' || reg.type === 'number_decimal') {
    const cond = NUMBER_CONDITIONS.find((c) => c.value === reg.type2)
    const label = cond ? cond.label : reg.type2
    const tail2 = numberConditionArity(reg.type2) === 2
      ? `${reg.value1} and ${reg.value2}`
      : reg.value1
    return `Number ${label} ${tail2}`
  }
  if (reg.type === 'date') {
    const cond = DATE_CONDITIONS.find((c) => c.value === reg.type2)
    const label = cond ? cond.label : reg.type2
    const tail2 = dateConditionArity(reg.type2) === 2
      ? `${reg.value1} and ${reg.value2}`
      : reg.value1
    return `Date ${label} ${tail2}`
  }
  if (reg.type === 'text_content') {
    const cond = TEXT_CONDITIONS.find((c) => c.value === reg.type2)
    return `Text ${cond ? cond.label : reg.type2} “${reg.value1}”`
  }
  if (reg.type === 'text_length') {
    const cond = NUMBER_CONDITIONS.find((c) => c.value === reg.type2)
    const label = cond ? cond.label : reg.type2
    const tail2 = numberConditionArity(reg.type2) === 2
      ? `${reg.value1} and ${reg.value2}`
      : reg.value1
    return `Text length ${label} ${tail2}`
  }
  return reg.type || 'Rule'
}

/**
 * cellKeysForRange — enumerate "row_col" keys covered by an inclusive 0-indexed
 * rectangle. Guards against absurd sizes so a stray whole-sheet range can't
 * lock the tab up building millions of keys.
 */
export function cellKeysForRange(rowRange: [number, number], colRange: [number, number], cap = 20000): string[] {
  const [r0, r1] = rowRange
  const [c0, c1] = colRange
  const keys: string[] = []
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      keys.push(`${r}_${c}`)
      if (keys.length >= cap) return keys
    }
  }
  return keys
}

/**
 * applyValidation — merge a regulation across every cell in `rangeText` on the
 * first sheet, returning a new workbook array (immutable). Removing = pass
 * regulation=null to clear those keys.
 *
 * `parseRangeFn` is injected (the A1-notation parser already lives in
 * ConditionalFormatPanel) to avoid duplicating that logic.
 */
export function applyValidation(
  data: DVSheet[],
  rangeText: string,
  regulation: Regulation | null,
  parseRangeFn: (rangeText: string) => { row: [number, number]; column: [number, number] }[] | undefined,
): DVSheet[] {
  const parsed = parseRangeFn(rangeText)?.[0]
  if (!parsed) return data
  const keys = cellKeysForRange(parsed.row, parsed.column)
  return data.map((sheet, idx) => {
    if (idx !== 0) return sheet
    const dv: Record<string, unknown> = { ...(sheet.dataVerification || {}) }
    for (const k of keys) {
      if (regulation) dv[k] = { ...regulation }
      else delete dv[k]
    }
    return { ...sheet, dataVerification: dv }
  })
}

/**
 * listValidationRules — collapse the per-cell dataVerification map into a
 * deduplicated, human-readable list of distinct rules (one entry per unique
 * regulation), each with the set of cell keys it covers. This is what the panel
 * shows, so a rule applied to A1:A10 reads as a single row, not ten.
 */
export function listValidationRules(sheet: DVSheet | null | undefined): ValidationRuleGroup[] {
  const dv = sheet?.dataVerification || {}
  const groups = new Map<string, { reg: Regulation; keys: string[] }>()
  for (const [key, reg] of Object.entries(dv)) {
    if (!reg) continue
    const r = reg as Regulation
    const sig = JSON.stringify([r.type, r.type2, r.value1, r.value2, !!r.checkbox])
    if (!groups.has(sig)) groups.set(sig, { reg: r, keys: [] })
    groups.get(sig)!.keys.push(key)
  }
  return [...groups.values()].map(({ reg, keys }) => ({
    reg,
    keys,
    summary: validationSummary(reg),
    count: keys.length,
  }))
}
