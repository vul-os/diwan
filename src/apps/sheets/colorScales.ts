/**
 * src/apps/sheets/colorScales.ts  (WAVE-63 — CF color scales + data bars,
 *                                  WAVE-64 — single-colour cell/text/date rules)
 *
 * Conditional-formatting COLOR SCALES, DATA BARS and SINGLE-COLOUR RULES as a
 * reactive, plain-data overlay — the same discipline as the WAVE-54 charts and
 * WAVE-63 pivots.
 *
 * Fortune-Sheet ships native `dataBar`/`colorGradation`/`greaterThan`/… code
 * paths, but they are buggy (the gradient scan requires the cell value to be
 * nil; `greaterThan` compares with a raw JS `>` so "9" beats 10; `occurrenceDate`
 * indexes a trimmed char; the `formula` rule pushes the CF cell into the sheet's
 * calcChain, corrupting the saved model) and hard to drive safely. So we compute
 * EVERY rule ourselves from the current cell values and hand Fortune-Sheet only
 * a paint instruction — giving us correct output AND full ownership of the CRDT
 * ingress validation.
 *
 * A rule is PLAIN STRUCTURED DATA stored on the first sheet as
 * `sheet.colorScales` (an array):
 *
 *   {
 *     id:    string,
 *     kind:  'colorScale2' | 'colorScale3' | 'dataBar'   // gradient family
 *          | 'greaterThan' | 'lessThan' | … | 'formula', // single-colour family
 *     range: 'A1:A10',                 // A1 source range (untrusted text)
 *     min:   '#f8696b',                // gradient hex colours (validated)
 *     mid:   '#ffeb84',                // colorScale3 only
 *     max:   '#63be7b',
 *     barColor: '#638ec6',             // dataBar only
 *     fill:  '#fce8e6',                // single-colour fill (validated)
 *     textColor: '#b71c1c',            // single-colour text colour ('' = keep)
 *     value1: '10', value2: '20',      // condition operands (untrusted text)
 *     formula: '=$A1>10',              // custom-formula rule only
 *   }
 *
 * computeColorScale reads the range's values every time they change and returns
 * a plain `{ "r_c": { bg } | { bar: { pct, color, negative } } }` map the overlay
 * paints. Reactive: the overlay memoises on a values signature so a rule only
 * recomputes when ITS cells change.
 *
 * SECURITY: every colour is validated to a strict `#rgb`/`#rrggbb` hex (an
 * unknown/hostile value is dropped to a safe default) so a rule can never inject
 * a `url(...)`/`expression(...)`/`javascript:` value into a style. Kinds are
 * allow-listed; operand/formula text is coerced to a control-char-free, length-
 * capped string and is only ever COMPARED against, never emitted into a style, a
 * DOM sink, or Fortune-Sheet's own model. Ranges are bounded (MAX_CELLS) and
 * clamped to the grid extent. The custom-formula rule is evaluated by OUR OWN
 * parser instance (bounded cell count, errors returned not thrown, no eval, no
 * DOM, no fetch) — the untrusted formula string never reaches Fortune-Sheet's
 * execfunction, so it cannot pollute the calcChain or crash the canvas. The
 * overlay paints background colours / bar widths only — never cell text — so
 * untrusted cell content is never rendered by this path at all.
 */
import { Parser, type FormulaCellCoord } from '@fortune-sheet/formula-parser'

export interface ColorScaleRule {
  id: string
  kind: string
  range: string
  min: string
  mid: string
  max: string
  barColor: string
  fill: string
  textColor: string
  value1: string
  value2: string
  formula: string
}

/** Loose, pre-validation input to `makeColorScale` — any field may arrive as
 * anything (a corrupt file, a hostile peer op), which is exactly what the
 * clamp below is for. */
export type ColorScaleRuleInput = Partial<Record<keyof ColorScaleRule, unknown>>

export interface CSCellFormat {
  fa?: string
  t?: string
  s?: unknown
}

export interface CSCellObject {
  v?: string | number | boolean | null
  m?: string | number
  ct?: CSCellFormat
  [key: string]: unknown
}

export type CSCellValue = string | number | boolean | null | undefined | CSCellObject

export interface CSCellEntry {
  r: number
  c: number
  v: CSCellValue
  [key: string]: unknown
}

export interface NativeCellRange {
  row: [number, number]
  column: [number, number]
}

export interface NativeConditionFormat {
  type: string
  conditionName: string
  cellrange: NativeCellRange[]
  conditionRange: NativeCellRange[]
  conditionValue: (string | number)[]
  format: { cellColor: string; textColor: string }
  __fromColorScale?: boolean
}

export interface CSSheet {
  id?: string
  row?: number
  column?: number
  celldata?: CSCellEntry[]
  colorScales?: ColorScaleRule[]
  luckysheet_conditionformat_save?: NativeConditionFormat[]
  [key: string]: unknown
}

export interface PaintBg {
  bg: string
  fg?: string
}
export interface PaintBar {
  bar: { pct: number; color: string; negative: boolean }
}
export type PaintInstruction = PaintBg | PaintBar
export type ColorScaleComputeMap = Record<string, PaintInstruction>

interface Bounds { r0: number; r1: number; c0: number; c1: number }

// Gradient family (own compute → banded native rules).
export const CS_SCALE_KINDS = ['colorScale2', 'colorScale3', 'dataBar']

// Single-colour family (own compute → per-cell native paint instruction).
export const CS_SINGLE_KINDS = [
  // numeric / cell-value
  'greaterThan', 'lessThan', 'greaterOrEqual', 'lessOrEqual',
  'between', 'notBetween', 'equalTo', 'notEqualTo',
  // text
  'textContains', 'textNotContains', 'textStartsWith', 'textEndsWith', 'textExactly',
  // date
  'dateBefore', 'dateAfter', 'dateToday', 'dateThisWeek', 'dateThisMonth',
  // presence / duplicates / custom
  'isEmpty', 'isNotEmpty', 'duplicate', 'formula',
]

export const CS_KINDS = [...CS_SCALE_KINDS, ...CS_SINGLE_KINDS]
const CS_KIND_SET: Set<string> = new Set(CS_KINDS)
const CS_SINGLE_SET: Set<string> = new Set(CS_SINGLE_KINDS)

/** True when the rule paints ONE colour over the cells it matches. */
export function isSingleKind(kind: unknown): boolean {
  return typeof kind === 'string' && CS_SINGLE_SET.has(kind)
}

export interface ColorScaleKindMeta {
  label: string
  args: 0 | 1 | 2
  input: 'number' | 'text' | 'date' | 'formula' | null
  group: 'scale' | 'value' | 'text' | 'date' | 'other'
}

/**
 * CS_KIND_META — per-kind label + operand arity + operand input type, so the
 * panel renders exactly the inputs a kind needs (and the tests can enumerate).
 *   args: how many of value1/value2 the kind reads (0, 1 or 2)
 *   input: 'number' | 'text' | 'date' | 'formula' | null
 */
export const CS_KIND_META: Record<string, ColorScaleKindMeta> = {
  colorScale2:     { label: '2-color scale',        args: 0, input: null,      group: 'scale' },
  colorScale3:     { label: '3-color scale',        args: 0, input: null,      group: 'scale' },
  dataBar:         { label: 'Data bar',             args: 0, input: null,      group: 'scale' },
  greaterThan:     { label: 'Greater than',         args: 1, input: 'number',  group: 'value' },
  lessThan:        { label: 'Less than',            args: 1, input: 'number',  group: 'value' },
  greaterOrEqual:  { label: 'Greater than or equal to', args: 1, input: 'number', group: 'value' },
  lessOrEqual:     { label: 'Less than or equal to',    args: 1, input: 'number', group: 'value' },
  between:         { label: 'Is between',           args: 2, input: 'number',  group: 'value' },
  notBetween:      { label: 'Is not between',       args: 2, input: 'number',  group: 'value' },
  equalTo:         { label: 'Is equal to',          args: 1, input: 'text',    group: 'value' },
  notEqualTo:      { label: 'Is not equal to',      args: 1, input: 'text',    group: 'value' },
  textContains:    { label: 'Text contains',        args: 1, input: 'text',    group: 'text' },
  textNotContains: { label: 'Text does not contain', args: 1, input: 'text',   group: 'text' },
  textStartsWith:  { label: 'Text starts with',     args: 1, input: 'text',    group: 'text' },
  textEndsWith:    { label: 'Text ends with',       args: 1, input: 'text',    group: 'text' },
  textExactly:     { label: 'Text is exactly',      args: 1, input: 'text',    group: 'text' },
  dateBefore:      { label: 'Date is before',       args: 1, input: 'date',    group: 'date' },
  dateAfter:       { label: 'Date is after',        args: 1, input: 'date',    group: 'date' },
  dateToday:       { label: 'Date is today',        args: 0, input: null,      group: 'date' },
  dateThisWeek:    { label: 'Date is this week',    args: 0, input: null,      group: 'date' },
  dateThisMonth:   { label: 'Date is this month',   args: 0, input: null,      group: 'date' },
  isEmpty:         { label: 'Cell is empty',        args: 0, input: null,      group: 'other' },
  isNotEmpty:      { label: 'Cell is not empty',    args: 0, input: null,      group: 'other' },
  duplicate:       { label: 'Duplicate values',     args: 0, input: null,      group: 'other' },
  formula:         { label: 'Custom formula is',    args: 0, input: 'formula', group: 'other' },
}

// Safe defaults (Excel-ish gradients; Google-ish single-colour highlight).
const DEF = {
  min: '#f8696b',   // red
  mid: '#ffeb84',   // yellow
  max: '#63be7b',   // green
  barColor: '#638ec6',
  fill: '#fce8e6',      // light red
  textColor: '#b71c1c', // dark red
}

const MAX_CELLS = 100000 // hard ceiling on a rule's scanned area
// A single-colour rule paints cell-by-cell, so its scan/paint/eval budgets are
// tighter than a gradient's (which collapses to 12 band rules whatever the size).
const MAX_MATCH_CELLS   = 20000 // cells a single-colour rule may test
const MAX_PAINT_CELLS   = 5000  // cells a single-colour rule may paint natively
const MAX_FORMULA_CELLS = 2000  // per-cell formula evaluations a rule may run

const MAX_VALUE_LEN   = 120 // condition operand text
const MAX_FORMULA_LEN = 300 // custom-formula text

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

/** Validate a hex colour; return the fallback (default safe colour) if invalid. */
export function safeColor(v: unknown, fallback = '#000000'): string {
  if (typeof v === 'string' && HEX_RE.test(v.trim())) return v.trim().toLowerCase()
  return fallback
}

/**
 * safeOptionalColor — like safeColor but "unset" is a first-class value: an
 * absent OR hostile colour collapses to '' (= leave the cell's own colour), so a
 * poisoned descriptor can never smuggle a non-hex string into a style.
 */
export function safeOptionalColor(v: unknown): string {
  if (v === '' || v === null || v === undefined) return ''
  return safeColor(v, '')
}

/**
 * safeText — coerce an untrusted operand to a plain, control-char-free, length-
 * capped string. Objects/arrays/functions (a hostile descriptor's favourite way
 * to smuggle a toString/valueOf side effect) collapse to ''.
 */
export function safeText(v: unknown, max = MAX_VALUE_LEN): string {
  if (typeof v === 'number' && isFinite(v)) return String(v).slice(0, max)
  if (typeof v === 'boolean') return String(v)
  if (typeof v !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\x00-\x1f\x7f]/g, '').slice(0, max)
}

let _seq = 0
export function newColorScaleId(): string {
  _seq = (_seq + 1) % 1e6
  return 'cs_' + Date.now().toString(36) + '_' + _seq.toString(36) + Math.random().toString(36).slice(2, 6)
}

/**
 * makeColorScale — construct a well-formed rule with defaults, clamping every
 * field. Unknown kind → 'colorScale2'. Colours forced to valid hex. Operand and
 * formula text coerced to a bounded plain string. This is the fail-closed
 * ingress clamp: run it on any peer-supplied rule.
 */
export function makeColorScale(partial: ColorScaleRuleInput = {}): ColorScaleRule {
  const kind = typeof partial.kind === 'string' && CS_KIND_SET.has(partial.kind) ? partial.kind : 'colorScale2'
  return {
    id:        typeof partial.id === 'string' && partial.id ? partial.id : newColorScaleId(),
    kind,
    range:     typeof partial.range === 'string' ? partial.range.trim().toUpperCase().slice(0, 40) : '',
    min:       safeColor(partial.min, DEF.min),
    mid:       safeColor(partial.mid, DEF.mid),
    max:       safeColor(partial.max, DEF.max),
    barColor:  safeColor(partial.barColor, DEF.barColor),
    fill:      safeColor(partial.fill, DEF.fill),
    textColor: safeOptionalColor(partial.textColor),
    value1:    safeText(partial.value1),
    value2:    safeText(partial.value2),
    formula:   safeText(partial.formula, MAX_FORMULA_LEN),
  }
}

/**
 * colorScaleError — the reason a rule can't be saved, or null when it is usable.
 * The panel's user-facing gate; matchCells enforces the same conditions silently
 * (a rule that can't match paints nothing), so the two can never diverge.
 */
export function colorScaleError(rule: ColorScaleRuleInput | null | undefined): string | null {
  const kind = typeof rule?.kind === 'string' ? rule.kind : undefined
  const meta = kind ? CS_KIND_META[kind] : undefined
  if (!meta || !rule) return 'Pick a condition.'
  if (!parseBounds(typeof rule.range === 'string' ? rule.range : '')) return 'Enter a valid range, e.g. A1:A10.'
  if (meta.input === 'formula') {
    return String(rule.formula || '').trim() ? null : 'Enter a formula, e.g. =$A1>10.'
  }
  if (meta.input === 'number') {
    const n1 = Number(String(rule.value1).trim())
    if (String(rule.value1).trim() === '' || !isFinite(n1)) return 'Enter a number for the condition.'
    if (meta.args === 2) {
      const n2 = Number(String(rule.value2).trim())
      if (String(rule.value2).trim() === '' || !isFinite(n2)) return 'Enter both numbers for the range.'
    }
    return null
  }
  if (meta.input === 'text') {
    return String(rule.value1).trim() ? null : 'Enter the text to match.'
  }
  if (meta.input === 'date') {
    return Number.isNaN(parseDay(rule.value1)) ? 'Enter a date, e.g. 2026-07-14.' : null
  }
  return null
}

/** colorScaleSummary — one-line human description of a rule, for the rule list. */
export function colorScaleSummary(rule: ColorScaleRuleInput | null | undefined): string {
  const kind = typeof rule?.kind === 'string' ? rule.kind : undefined
  const meta = kind ? CS_KIND_META[kind] : undefined
  if (!meta || !rule) return 'Rule'
  if (rule.kind === 'formula') return `Custom formula ${rule.formula || ''}`.trim()
  if (meta.args === 2) return `${meta.label} ${rule.value1} and ${rule.value2}`
  if (meta.args === 1) return `${meta.label} ${rule.value1}`
  return meta.label
}

export function getColorScales(data: CSSheet[] | null | undefined): ColorScaleRule[] {
  const arr = data?.[0]?.colorScales
  return Array.isArray(arr) ? arr : []
}

export function setColorScales(data: CSSheet[] | null | undefined, rules: unknown): CSSheet[] {
  return (data || []).map((sheet, idx) =>
    idx === 0 ? { ...sheet, colorScales: Array.isArray(rules) ? rules : [] } : sheet
  )
}

export function insertColorScale(data: CSSheet[] | null | undefined, rule: ColorScaleRuleInput): CSSheet[] {
  return setColorScales(data, [...getColorScales(data), makeColorScale(rule)])
}

export function updateColorScale(data: CSSheet[] | null | undefined, id: string, patch: ColorScaleRuleInput): CSSheet[] {
  const next = getColorScales(data).map((r) => (r.id === id ? makeColorScale({ ...r, ...patch }) : r))
  return setColorScales(data, next)
}

export function deleteColorScale(data: CSSheet[] | null | undefined, id: string): CSSheet[] {
  return setColorScales(data, getColorScales(data).filter((r) => r.id !== id))
}

export function clampColorScales(data: CSSheet[] | null | undefined): CSSheet[] | null | undefined {
  const rules = getColorScales(data)
  if (!rules.length) return data
  return setColorScales(data, rules.map((r) => makeColorScale(r)))
}

// Preserve across FortuneSheet onChange (app-owned overlay, dropped by onChange).
export function colorScalesBySheetId(data: CSSheet[] | null | undefined): Map<string, ColorScaleRule[]> {
  const map = new Map<string, ColorScaleRule[]>()
  ;(data || []).forEach((sheet, idx) => {
    if (Array.isArray(sheet?.colorScales) && sheet.colorScales.length) {
      map.set(sheet?.id ?? `#${idx}`, sheet.colorScales)
    }
  })
  return map
}
export function mergeColorScales(
  nextData: CSSheet[] | null | undefined,
  map: Map<string, ColorScaleRule[]> | null | undefined,
): CSSheet[] | null | undefined {
  if (!map || map.size === 0) return nextData
  return (nextData || []).map((sheet, idx) => {
    const key = sheet?.id ?? `#${idx}`
    const preserved = map.get(key) ?? (idx === 0 ? map.values().next().value : undefined)
    if (Array.isArray(sheet?.colorScales) && sheet.colorScales.length) return sheet
    if (preserved && preserved.length) return { ...sheet, colorScales: preserved }
    return sheet
  })
}

// ── range parsing (local, bounded) ───────────────────────────────────────────
function colToIndex(letters: string): number {
  const s = String(letters).toUpperCase()
  let idx = 0
  for (let i = 0; i < s.length; i++) idx = idx * 26 + (s.charCodeAt(i) - 64)
  return idx - 1
}
function parseA1(ref: string): { c: number; r: number } | null {
  const m = String(ref).match(/^([A-Za-z]+)(\d+)$/)
  if (!m) return null
  return { c: colToIndex(m[1]), r: parseInt(m[2], 10) - 1 }
}
export function parseBounds(range: string | undefined | null): Bounds | null {
  const parts = String(range || '').trim().toUpperCase().split(':')
  if (parts.length === 1) {
    const a = parseA1(parts[0]); if (!a) return null
    return { r0: a.r, r1: a.r, c0: a.c, c1: a.c }
  }
  const a = parseA1(parts[0]), b = parseA1(parts[1])
  if (!a || !b) return null
  return { r0: Math.min(a.r, b.r), r1: Math.max(a.r, b.r), c0: Math.min(a.c, b.c), c1: Math.max(a.c, b.c) }
}

function cellNumber(cell: CSCellEntry | undefined): number {
  const v = cell?.v
  let d: unknown
  if (v === null || v === undefined) return NaN
  if (typeof v === 'object') d = v.v !== undefined && v.v !== null ? v.v : v.m
  else d = v
  if (typeof d === 'number') return d
  if (typeof d === 'string' && d.trim() !== '') {
    const s = d.trim()
    const isPct = /%\s*$/.test(s)
    // Strip currency/grouping/whitespace (and the trailing %), then SCALE a
    // percentage string by 1/100 so "50%" reads as 0.5 — otherwise a percent
    // cell would be read 100× too large and distort the whole gradient/bar scale.
    const n = Number(s.replace(/[$,%\s]/g, ''))
    if (!isFinite(n)) return NaN
    return isPct ? n / 100 : n
  }
  return NaN
}

// ── single-colour rule evaluation (WAVE-64) ─────────────────────────────────
// All of it is OURS: Fortune-Sheet's own greaterThan/textContains/occurrenceDate/
// duplicateValue/formula evaluation is either wrong (string `>` comparison, a
// mis-indexed date split) or unsafe (its `formula` rule writes the CF cell into
// the sheet's calcChain). We match cells here and hand FS a paint instruction.

/** Raw underlying value of a cell (number | string | null). */
function cellRaw(cell: CSCellEntry | undefined): string | number | boolean | null {
  const v = cell?.v
  if (v === null || v === undefined) return null
  if (typeof v === 'object') {
    const d = v.v !== undefined && v.v !== null ? v.v : v.m
    return d === undefined || d === null || typeof d === 'object' ? null : d
  }
  return typeof v === 'object' ? null : v
}

/** Cell value as plain display text ('' when the cell is empty). */
export function cellString(cell: CSCellEntry | undefined): string {
  const v = cell?.v
  // A date cell carries an Excel serial in `v` and the readable date in `m`.
  if (typeof v === 'object' && v?.ct?.t === 'd' && typeof v.m === 'string') return v.m
  const raw = cellRaw(cell)
  return raw === null ? '' : String(raw)
}

function isBlankCell(cell: CSCellEntry | undefined): boolean { return cellString(cell).trim() === '' }

// Dates live on the Excel serial-day axis (1899-12-30 = day 0) so a numeric date
// cell and a parsed 'YYYY-MM-DD' string compare on ONE scale, TZ-independently.
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30)
const DAY_MS = 86400000

function dayFromYMD(y: number, m: number, d: number): number {
  if (!(y >= 1000 && y <= 9999) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return NaN
  const t = Date.UTC(y, m - 1, d)
  const back = new Date(t)
  // Reject impossible dates (2024-02-31 rolls over → not the day we asked for).
  if (back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return NaN
  return Math.round((t - EXCEL_EPOCH_UTC) / DAY_MS)
}

/** parseDay — 'YYYY-MM-DD' | 'YYYY/M/D' | 'M/D/YYYY' → Excel serial day, else NaN. */
export function parseDay(text: unknown): number {
  const s = String(text ?? '').trim()
  if (!s) return NaN
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/)
  if (m) return dayFromYMD(+m[1], +m[2], +m[3])
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (m) return dayFromYMD(+m[3], +m[1], +m[2])
  return NaN
}

/** Cell value as an Excel serial day, or NaN when it isn't a date. */
export function cellDay(cell: CSCellEntry | undefined): number {
  const v = cell?.v
  const raw = cellRaw(cell)
  if (typeof v === 'object' && v?.ct?.t === 'd' && typeof raw === 'number') return Math.floor(raw)
  if (typeof raw === 'string') return parseDay(raw)
  if (typeof v === 'object' && typeof v?.m === 'string') return parseDay(v.m)
  return NaN
}

/** todayDay — `now` as an Excel serial day, on the user's LOCAL calendar. */
export function todayDay(now: Date = new Date()): number {
  return dayFromYMD(now.getFullYear(), now.getMonth() + 1, now.getDate())
}

/** dateWindow — inclusive [from, to] serial-day window for a relative date kind. */
export function dateWindow(kind: string, now: Date = new Date()): [number, number] | null {
  const today = todayDay(now)
  if (kind === 'dateToday') return [today, today]
  if (kind === 'dateThisWeek') {
    const start = today - now.getDay() // week starts Sunday, as in Sheets
    return [start, start + 6]
  }
  if (kind === 'dateThisMonth') {
    const y = now.getFullYear(), m = now.getMonth() + 1
    const first = dayFromYMD(y, m, 1)
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate()
    return [first, dayFromYMD(y, m, days)]
  }
  return null
}

const norm = (s: unknown): string => String(s ?? '').trim().toLowerCase()

interface RuleOperands {
  n1?: number
  n2?: number
  t1?: string
  d1?: number
  formula?: string
}

/**
 * ruleOperands — the rule's own operands, parsed + validated for its kind.
 * Returns null when the rule can never match (missing/invalid operand) — the
 * fail-closed "match nothing" path, so a half-filled or hostile rule paints
 * NOTHING rather than painting everything.
 */
function ruleOperands(rule: ColorScaleRule | null | undefined): RuleOperands | null {
  const meta = rule ? CS_KIND_META[rule.kind] : undefined
  if (!meta || !rule) return null
  const { kind } = rule
  if (meta.input === 'number' || kind === 'equalTo' || kind === 'notEqualTo') {
    const n1 = Number(String(rule.value1).trim())
    const n2 = Number(String(rule.value2).trim())
    const numeric1 = String(rule.value1).trim() !== '' && isFinite(n1)
    const numeric2 = String(rule.value2).trim() !== '' && isFinite(n2)
    if (meta.input === 'number') {
      if (!numeric1) return null
      if (meta.args === 2 && !numeric2) return null
      return { n1, n2 }
    }
    // equalTo / notEqualTo compare numerically when BOTH sides are numbers,
    // else case-insensitively as text (Sheets semantics).
    if (String(rule.value1).trim() === '') return null
    return { n1: numeric1 ? n1 : NaN, t1: norm(rule.value1) }
  }
  if (meta.input === 'text') {
    const t1 = norm(rule.value1)
    if (t1 === '') return null
    return { t1 }
  }
  if (meta.input === 'date') {
    const d1 = parseDay(rule.value1)
    if (Number.isNaN(d1)) return null
    return { d1 }
  }
  if (meta.input === 'formula') {
    const f = String(rule.formula || '').trim()
    if (!f) return null
    return { formula: f }
  }
  return {}
}

/**
 * evalFormulaRule — evaluate a custom-formula rule ('=$A1>10') once per cell in
 * the range and return the matching keys.
 *
 * SAFETY: we run OUR OWN `@fortune-sheet/formula-parser` instance — the same
 * engine the grid already uses for cell formulas, which PARSES (never evals) and
 * returns `{ error, result }` instead of throwing. Relative/absolute references
 * are resolved by us against the range's top-left anchor (Sheets semantics), so
 * the untrusted string is never handed to Fortune-Sheet's `execfunction` — which
 * would push the CF cell into the sheet's calcChain and corrupt the saved model.
 * Bounded by MAX_FORMULA_CELLS; any throw → no matches (fail-closed).
 */
function evalFormulaRule(
  formula: string,
  cells: { r: number; c: number }[],
  idx: Map<string, CSCellEntry>,
  b: Bounds,
  limit: number,
): { r: number; c: number }[] {
  const out: { r: number; c: number }[] = []
  try {
    const parser = new Parser()
    let cur = { r: b.r0, c: b.c0 }
    const resolve = (coord: FormulaCellCoord) => ({
      r: coord.row.isAbsolute    ? coord.row.index    : coord.row.index    + (cur.r - b.r0),
      c: coord.column.isAbsolute ? coord.column.index : coord.column.index + (cur.c - b.c0),
    })
    const valueAt = (r: number, c: number) => {
      if (r < 0 || c < 0) return null
      return cellRaw(idx.get(r + ',' + c))
    }
    // NOTE the arity: this parser fork emits (coord, options, done) — a 2-arg
    // handler silently binds `done` to the options object and every reference
    // resolves to #ERROR!.
    parser.on('callCellValue', (coord, _options, done) => {
      const { r, c } = resolve(coord)
      done(valueAt(r, c))
    })
    parser.on('callRangeValue', (start, end, _options, done) => {
      const s = resolve(start), e = resolve(end)
      const grid = []
      const rows = Math.min(e.r, s.r + MAX_MATCH_CELLS)
      for (let r = s.r; r <= rows; r++) {
        const row = []
        for (let c = s.c; c <= e.c; c++) row.push(valueAt(r, c))
        grid.push(row)
      }
      done(grid)
    })
    const text = formula.replace(/^\s*=/, '')
    if (!text) return out
    let evals = 0
    for (const cell of cells) {
      if (++evals > limit) break
      cur = cell
      const res = parser.parse(text)
      if (res?.error) continue
      if (truthy(res?.result)) out.push(cell)
    }
  } catch {
    return [] // a parser blow-up must never take the grid down
  }
  return out
}

/** Spreadsheet truthiness of a formula result. */
function truthy(v: unknown): boolean {
  if (v === true) return true
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') return v.trim().toUpperCase() === 'TRUE'
  return false
}

/** gridExtent — the rows/cols Fortune-Sheet actually materialises for a sheet. */
function gridExtent(sheet: CSSheet | undefined): { rows: number; cols: number; usedR: number; usedC: number } {
  let usedR = -1, usedC = -1
  for (const cell of sheet?.celldata || []) {
    if (cell.r > usedR) usedR = cell.r
    if (cell.c > usedC) usedC = cell.c
  }
  const rows = Math.max(Number.isFinite(sheet?.row) ? (sheet?.row as number) : 100, usedR + 1)
  const cols = Math.max(Number.isFinite(sheet?.column) ? (sheet?.column as number) : 26, usedC + 1)
  return { rows, cols, usedR, usedC }
}

/**
 * matchCells — the cells a SINGLE-COLOUR rule paints, as [{ r, c }].
 * Bounded to the grid extent (a rule may not address a row/col Fortune-Sheet has
 * not materialised — its own duplicateValue compute would dereference it and
 * throw) and to MAX_MATCH_CELLS. Returns [] for a rule that cannot match.
 */
export function matchCells(rule: ColorScaleRule | null | undefined, sheet: CSSheet | undefined, now: Date = new Date()): { r: number; c: number }[] {
  if (!isSingleKind(rule?.kind)) return []
  const b = parseBounds(rule?.range)
  if (!b) return []
  const ops = ruleOperands(rule)
  if (!ops) return []

  const { rows, cols } = gridExtent(sheet)
  const r1 = Math.min(b.r1, rows - 1)
  const c1 = Math.min(b.c1, cols - 1)
  if (b.r0 > r1 || b.c0 > c1) return []
  if ((r1 - b.r0 + 1) * (c1 - b.c0 + 1) > MAX_MATCH_CELLS) return []

  const idx = new Map<string, CSCellEntry>()
  for (const cell of sheet?.celldata || []) idx.set(cell.r + ',' + cell.c, cell)

  const cells: { r: number; c: number }[] = []
  for (let r = b.r0; r <= r1; r++) for (let c = b.c0; c <= c1; c++) cells.push({ r, c })

  const kind = rule?.kind

  if (kind === 'formula') {
    return evalFormulaRule(ops.formula as string, cells, idx, b, MAX_FORMULA_CELLS)
  }

  if (kind === 'duplicate') {
    const counts = new Map<string, number>()
    for (const { r, c } of cells) {
      const t = norm(cellString(idx.get(r + ',' + c)))
      if (t === '') continue
      counts.set(t, (counts.get(t) || 0) + 1)
    }
    return cells.filter(({ r, c }) => {
      const t = norm(cellString(idx.get(r + ',' + c)))
      return t !== '' && (counts.get(t) || 0) > 1
    })
  }

  const window = dateWindow(kind as string, now)

  return cells.filter(({ r, c }) => {
    const cell = idx.get(r + ',' + c)
    const blank = isBlankCell(cell)
    if (kind === 'isEmpty') return blank
    if (kind === 'isNotEmpty') return !blank
    // Every remaining kind is a predicate over a cell that HAS content: an empty
    // cell is never highlighted (Sheets does the same — an empty cell is not
    // "not equal to 5", it is simply blank).
    if (blank) return false

    switch (kind) {
      case 'greaterThan':    { const n = cellNumber(cell); return !Number.isNaN(n) && n >  (ops.n1 as number) }
      case 'lessThan':       { const n = cellNumber(cell); return !Number.isNaN(n) && n <  (ops.n1 as number) }
      case 'greaterOrEqual': { const n = cellNumber(cell); return !Number.isNaN(n) && n >= (ops.n1 as number) }
      case 'lessOrEqual':    { const n = cellNumber(cell); return !Number.isNaN(n) && n <= (ops.n1 as number) }
      case 'between': {
        const n = cellNumber(cell)
        const lo = Math.min(ops.n1 as number, ops.n2 as number), hi = Math.max(ops.n1 as number, ops.n2 as number)
        return !Number.isNaN(n) && n >= lo && n <= hi
      }
      case 'notBetween': {
        const n = cellNumber(cell)
        const lo = Math.min(ops.n1 as number, ops.n2 as number), hi = Math.max(ops.n1 as number, ops.n2 as number)
        return !Number.isNaN(n) && (n < lo || n > hi)
      }
      case 'equalTo':
      case 'notEqualTo': {
        const n = cellNumber(cell)
        const eq = ops.n1 !== undefined && !Number.isNaN(ops.n1) && !Number.isNaN(n)
          ? n === ops.n1
          : norm(cellString(cell)) === ops.t1
        return kind === 'equalTo' ? eq : !eq
      }
      case 'textContains':    return norm(cellString(cell)).includes(ops.t1 as string)
      case 'textNotContains': return !norm(cellString(cell)).includes(ops.t1 as string)
      case 'textStartsWith':  return norm(cellString(cell)).startsWith(ops.t1 as string)
      case 'textEndsWith':    return norm(cellString(cell)).endsWith(ops.t1 as string)
      case 'textExactly':     return norm(cellString(cell)) === ops.t1
      case 'dateBefore':      { const d = cellDay(cell); return !Number.isNaN(d) && d <  (ops.d1 as number) }
      case 'dateAfter':       { const d = cellDay(cell); return !Number.isNaN(d) && d >  (ops.d1 as number) }
      case 'dateToday':
      case 'dateThisWeek':
      case 'dateThisMonth':   { const d = cellDay(cell); return !Number.isNaN(d) && !!window && d >= window[0] && d <= window[1] }
      default: return false
    }
  })
}

// Linear interpolate two hex colours; t in [0,1].
function lerpHex(a: string, b: string, t: number): string {
  const pa = hexToRgb(a), pb = hexToRgb(b)
  const r = Math.round(pa.r + (pb.r - pa.r) * t)
  const g = Math.round(pa.g + (pb.g - pa.g) * t)
  const bl = Math.round(pa.b + (pb.b - pa.b) * t)
  return `rgb(${r}, ${g}, ${bl})`
}
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map((x) => x + x).join('')
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }
}

/**
 * computeColorScale — turn a rule + the current sheet cells into a plain map
 * keyed `"r_c"` describing what to paint for each cell in the range:
 *   colorScale   → { bg: 'rgb(...)' }
 *   dataBar      → { bar: { pct: 0..1, color, negative: bool } }
 *   single-colour → { bg: '#hex', fg: '#hex' | '' }   (only the MATCHED cells)
 * Reactive core: recompute whenever the range's values change. Bounded by
 * MAX_CELLS. Returns {} when the range is invalid or nothing matches.
 */
export function computeColorScale(rule: ColorScaleRule, sheet: CSSheet | undefined, now: Date = new Date()): ColorScaleComputeMap {
  if (isSingleKind(rule?.kind)) {
    const out: ColorScaleComputeMap = {}
    const bg = safeColor(rule.fill, DEF.fill)
    const fg = safeOptionalColor(rule.textColor)
    for (const { r, c } of matchCells(rule, sheet, now)) out[r + '_' + c] = { bg, fg }
    return out
  }
  const b = parseBounds(rule?.range)
  if (!b) return {}
  const idx = new Map<string, CSCellEntry>()
  let usedR = -1, usedC = -1
  for (const cell of sheet?.celldata || []) {
    idx.set(cell.r + ',' + cell.c, cell)
    if (cell.r > usedR) usedR = cell.r
    if (cell.c > usedC) usedC = cell.c
  }
  const r1 = Math.min(b.r1, Math.max(usedR, b.r0))
  const c1 = Math.min(b.c1, Math.max(usedC, b.c0))
  if ((r1 - b.r0 + 1) * (c1 - b.c0 + 1) > MAX_CELLS) return {}

  // First pass: collect numeric values + min/max.
  const nums: { r: number; c: number; n: number }[] = []
  let min = Infinity, max = -Infinity
  for (let r = b.r0; r <= r1; r++) {
    for (let c = b.c0; c <= c1; c++) {
      const n = cellNumber(idx.get(r + ',' + c))
      if (!Number.isNaN(n)) { nums.push({ r, c, n }); if (n < min) min = n; if (n > max) max = n }
    }
  }
  if (nums.length === 0 || !isFinite(min) || !isFinite(max)) return {}

  const out: ColorScaleComputeMap = {}
  if (rule.kind === 'dataBar') {
    const color = safeColor(rule.barColor, DEF.barColor)
    // Bars are proportional to |value| against the larger magnitude of min/max,
    // so a mix of +/- values scales sensibly. Negative values paint left.
    const scale = Math.max(Math.abs(min), Math.abs(max)) || 1
    for (const { r, c, n } of nums) {
      out[r + '_' + c] = { bar: { pct: Math.min(1, Math.abs(n) / scale), color, negative: n < 0 } }
    }
    return out
  }

  // Color scales. 2-colour = min→max; 3-colour = min→mid→max around the midpoint.
  const three = rule.kind === 'colorScale3'
  const mid = (min + max) / 2
  const cMin = safeColor(rule.min, DEF.min)
  const cMid = safeColor(rule.mid, DEF.mid)
  const cMax = safeColor(rule.max, DEF.max)
  for (const { r, c, n } of nums) {
    let bg: string
    if (max === min) {
      bg = three ? lerpHex(cMin, cMax, 0.5) : cMin
    } else if (three) {
      if (n <= mid) {
        const t = mid === min ? 0 : (n - min) / (mid - min)
        bg = lerpHex(cMin, cMid, t)
      } else {
        const t = max === mid ? 1 : (n - mid) / (max - mid)
        bg = lerpHex(cMid, cMax, t)
      }
    } else {
      bg = lerpHex(cMin, cMax, (n - min) / (max - min))
    }
    out[r + '_' + c] = { bg }
  }
  return out
}

/**
 * colorScaleSignature — cheap fingerprint of exactly the cells a rule depends on
 * plus its own config, so the overlay only recomputes when they change.
 */
export function colorScaleSignature(rule: ColorScaleRule, sheet: CSSheet | undefined): string {
  const b = parseBounds(rule?.range)
  if (!b) return rule.id + '|invalid'
  // A custom-formula rule may read ANY cell (=$Z$1>0), so its fingerprint spans
  // the whole sheet; every other kind depends only on its own range.
  const wide = rule.kind === 'formula'
  const parts: string[] = []
  for (const cell of sheet?.celldata || []) {
    if (!wide && (cell.r < b.r0 || cell.r > b.r1 || cell.c < b.c0 || cell.c > b.c1)) continue
    // Single-colour rules match on TEXT and DATES too, so fingerprint the string
    // form — a numeric-only signature would miss "abc" → "abd" and never repaint.
    const v = isSingleKind(rule.kind) || wide ? cellString(cell) : cellNumber(cell)
    if (typeof v === 'string' ? v !== '' : !Number.isNaN(v)) parts.push(cell.r + ':' + cell.c + '=' + v)
  }
  parts.sort()
  return [
    rule.kind, rule.range, rule.min, rule.mid, rule.max, rule.barColor,
    rule.fill, rule.textColor, rule.value1, rule.value2, rule.formula,
    parts.join(','),
  ].join('|')
}

/**
 * Merge all rules' compute maps into one paint map (later rules win on overlap).
 * Every rule is re-clamped (makeColorScale) on the way in — the DOM overlay is a
 * render path, and no render path may ever read an unclamped descriptor.
 */
export function computeAllColorScales(rules: ColorScaleRuleInput[] | null | undefined, sheet: CSSheet | undefined, now: Date = new Date()): ColorScaleComputeMap {
  const merged: ColorScaleComputeMap = {}
  for (const rule of rules || []) {
    const m = computeColorScale(makeColorScale(rule), sheet, now)
    for (const k in m) merged[k] = m[k]
  }
  return merged
}

// rgb(...) string → #rrggbb hex (for cellColor which FS renders on the canvas).
function rgbToHex(rgb: string): string {
  const m = String(rgb).match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (!m) return '#000000'
  const h = (n: string) => Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, '0')
  return '#' + h(m[1]) + h(m[2]) + h(m[3])
}

const NATIVE_BANDS = 12 // gradient resolution for the native banded rendering

/**
 * toNativeSingleColor — render ONE single-colour rule (greater-than / text /
 * date / empty / duplicate / custom-formula) on the FS canvas.
 *
 * We do NOT use Fortune-Sheet's own greaterThan/textContains/occurrenceDate/
 * duplicateValue/formula evaluation: it is wrong on several kinds (a raw JS `>`
 * makes the string "9" beat 10), missing on others (no empty / starts-with /
 * relative-date rule at all), and its `formula` rule pushes each CF cell into
 * the sheet's calcChain — corrupting the model we then save.
 *
 * Instead WE decide which cells match (matchCells) and hand FS a pure PAINT
 * INSTRUCTION: one rule whose `cellrange` is the list of matched cells as 1×1
 * rects, with `duplicateValue` + conditionValue ['1'] ("colour the values that
 * occur once in this range") — over a 1×1 range that is unconditionally the one
 * cell in it, whatever it contains. It is the only native condition that paints
 * a cell without inspecting it, and — unlike every other branch — it also paints
 * EMPTY cells, which is what makes an "is empty" rule renderable at all.
 *
 * SECURITY: nothing user-supplied crosses into FS here. conditionValue is our
 * own constant '1', the colours are validated hex from our palette, and the
 * cellrange indices are integers clamped to the grid extent (FS's duplicateValue
 * compute dereferences `data[r][c]` with no bounds check — an out-of-extent rect
 * would throw inside the canvas draw and take the grid down). Bounded by
 * MAX_PAINT_CELLS.
 */
export function toNativeSingleColor(rule: ColorScaleRule, sheet: CSSheet | undefined, now: Date = new Date()): NativeConditionFormat[] {
  const matched = matchCells(rule, sheet, now)
  if (matched.length === 0) return []
  const cellrange: NativeCellRange[] = matched.slice(0, MAX_PAINT_CELLS).map(({ r, c }) => ({
    row: [r, r], column: [c, c],
  }))
  return [{
    type: 'default',
    conditionName: 'duplicateValue',
    cellrange,
    conditionRange: cellrange,
    conditionValue: ['1'],
    format: {
      cellColor: safeColor(rule.fill, DEF.fill),
      textColor: safeOptionalColor(rule.textColor),
    },
  }]
}

/**
 * toNativeConditionFormat — convert ONE app rule into the FortuneSheet-native
 * conditionformat rules that render it on the FS CANVAS (FS renders on a canvas,
 * so there are no DOM cells to overlay).
 *
 * Single-colour rules → one paint instruction (see toNativeSingleColor).
 *
 * Color scales / data bars → a set of native `between` rules: FS's built-in
 * `colorGradation`/`dataBar` compute is buggy, but its `between` cell-colour path
 * is sound. We slice the rule's value domain into NATIVE_BANDS buckets, colour
 * each bucket with the interpolated gradient colour (data bars → an intensity
 * ramp of the bar colour), and emit a `between` rule per bucket over the same
 * range. Returns [] when the range has no numeric data.
 *
 * SECURITY: the emitted cellColor is always a `#rrggbb` derived from our own
 * validated palette (never a cell-derived string), and conditionValue is numeric
 * — so a rule can't inject a hostile colour or value into FS's model.
 */
export function toNativeConditionFormat(
  rule: ColorScaleRule,
  sheet: CSSheet | undefined,
  parseRangeFS: ((range: string) => NativeCellRange[]) | undefined,
  now: Date = new Date(),
): NativeConditionFormat[] {
  if (isSingleKind(rule?.kind)) return toNativeSingleColor(rule, sheet, now)
  const b = parseBounds(rule?.range)
  if (!b) return []
  const idx = new Map<string, CSCellEntry>()
  for (const cell of sheet?.celldata || []) idx.set(cell.r + ',' + cell.c, cell)
  let min = Infinity, max = -Infinity, any = false
  for (let r = b.r0; r <= b.r1; r++) {
    for (let c = b.c0; c <= b.c1; c++) {
      const n = cellNumber(idx.get(r + ',' + c))
      if (!Number.isNaN(n)) { any = true; if (n < min) min = n; if (n > max) max = n }
    }
  }
  if (!any || !isFinite(min) || !isFinite(max)) return []
  const cellrange: NativeCellRange[] = typeof parseRangeFS === 'function'
    ? parseRangeFS(rule.range)
    : [{ row: [b.r0, b.r1], column: [b.c0, b.c1] }]

  const span = max - min || 1
  const isBar = rule.kind === 'dataBar'
  const three = rule.kind === 'colorScale3'
  const cMin = safeColor(rule.min, DEF.min)
  const cMid = safeColor(rule.mid, DEF.mid)
  const cMax = safeColor(rule.max, DEF.max)
  const barCol = safeColor(rule.barColor, DEF.barColor)

  // FortuneSheet's `between` is inclusive on BOTH ends, so adjacent bands that
  // shared a boundary would double-match a value sitting exactly on it (the
  // common case for integer data). We make the bands half-open by nudging every
  // band's lower bound (except the first) up by a tiny epsilon of the span, so a
  // boundary value falls in exactly one band and gets the intended colour.
  const eps = span * 1e-9
  const out: NativeConditionFormat[] = []
  for (let i = 0; i < NATIVE_BANDS; i++) {
    const t0 = i / NATIVE_BANDS
    const t1 = (i + 1) / NATIVE_BANDS
    const lo = i === 0 ? min : min + span * t0 + eps
    const hi = i === NATIVE_BANDS - 1 ? max : min + span * t1
    const mt = (t0 + t1) / 2 // colour sampled at the band centre
    let color: string
    if (isBar) {
      // Approximate a data bar with an intensity ramp: lighter → the bar colour.
      color = rgbToHex(lerpHex('#ffffff', barCol, mt))
    } else if (three) {
      color = mt <= 0.5 ? rgbToHex(lerpHex(cMin, cMid, mt / 0.5)) : rgbToHex(lerpHex(cMid, cMax, (mt - 0.5) / 0.5))
    } else {
      color = rgbToHex(lerpHex(cMin, cMax, mt))
    }
    out.push({
      type: 'default',
      conditionName: 'between',
      cellrange,
      conditionRange: cellrange,
      conditionValue: [lo, hi],
      format: { cellColor: color, textColor: '' },
    })
  }
  return out
}

/**
 * buildNativeConditionFormat — merge the app's legacy native CF rules
 * (luckysheet_conditionformat_save from an older file) with the rules derived
 * from every app rule (single-colour paints + color-scale bands), so both render
 * on the canvas together. Derived rules go FIRST, in rule order, so a later rule
 * wins on overlap — the same precedence computeAllColorScales gives the overlay.
 *
 * SECURITY: every rule is re-clamped through makeColorScale here. This is the
 * LAST gate before render: a descriptor that reached `sheet.colorScales` by any
 * path (a corrupt file, a legacy record, a hostile peer op, a future code path
 * that forgets the ingress clamp) is normalised — allow-listed kind, hex-only
 * colours, bounded operand text — before a single pixel is derived from it.
 */
export function buildNativeConditionFormat(
  sheet: CSSheet | undefined,
  parseRangeFS: ((range: string) => NativeCellRange[]) | undefined,
  now: Date = new Date(),
): NativeConditionFormat[] {
  const userRules = Array.isArray(sheet?.luckysheet_conditionformat_save)
    ? sheet.luckysheet_conditionformat_save.filter((r) => !r?.__fromColorScale)
    : []
  const scales = Array.isArray(sheet?.colorScales) ? sheet.colorScales : []
  const derived: NativeConditionFormat[] = []
  for (const rule of scales) {
    for (const nat of toNativeConditionFormat(makeColorScale(rule), sheet, parseRangeFS, now)) {
      derived.push({ ...nat, __fromColorScale: true })
    }
  }
  return [...derived, ...userRules]
}
