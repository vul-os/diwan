/**
 * src/apps/sheets/formulaFunctions.ts  (WAVE-63 — comprehensive formulas)
 *
 * High-value spreadsheet functions that @formulajs/formulajs (the engine
 * Fortune-Sheet's formula-parser falls back to) does NOT ship: XLOOKUP,
 * TEXTJOIN, IFS, SWITCH, LET, XMATCH, and the scalar-safe subset of the dynamic
 * array family (FILTER / SORT / UNIQUE).
 *
 * ── Integration seam ────────────────────────────────────────────────────────
 * Fortune-Sheet evaluates a formula through a single `@fortune-sheet/formula
 * -parser` Parser instance held on `ctx.formulaCache.parser`. When a function is
 * called the parser resolves it in this order (see parser `_callFunction`):
 *   1. `this.getFunction(name)`  — per-instance custom functions
 *   2. `callFunction` listeners  — event override
 *   3. `evaluateByOperator(name)` — falls through to `formulajs[name]`
 * Unknown names throw `#NAME?`.
 *
 * The core creates its Parser internally and never exposes the instance to the
 * app, so we register our functions by wrapping `Parser.prototype.getFunction`
 * ONCE (idempotent, install-guarded). Every Parser the core constructs then
 * resolves our names before falling through to the built-ins — so the functions
 * evaluate LIVE and recalculate on dependency change exactly like a native
 * function, with zero fork of the library. Built-ins are untouched (we only
 * answer names we own; everything else defers to the original resolver).
 *
 * ── Argument shape (verified at runtime) ────────────────────────────────────
 * The parser passes each function a single `params` array. A cell reference
 * arrives as a scalar; a RANGE arrives as a 2-D array `[[..row..], ..]`; a
 * literal arrives as-is. Errors bubble as strings like '#N/A'. We mirror
 * formulajs conventions so mixed use composes cleanly.
 *
 * ── SECURITY ────────────────────────────────────────────────────────────────
 * Nothing here evals code, builds HTML, fetches a URL, or touches the DOM. Every
 * function is a pure data transform over already-parsed argument values. Text
 * results are plain strings returned into a cell — they are React-escaped
 * wherever rendered and pass the existing WAVE-14 sanitiser / CSV-injection
 * guard on export. There is no new sink. LET does NOT create a general binding
 * language — it only substitutes name→value pairs positionally (no code path),
 * so it cannot smuggle execution.
 */

/** A single resolved cell/literal value, as the parser hands it to a function. */
export type CellScalar = string | number | boolean | null | undefined

/** The parser's `params` shape: a scalar, or a (possibly nested/2-D) range array. */
export type FormulaArg = CellScalar | FormulaArg[]

// ── low-level value helpers ──────────────────────────────────────────────────

/** Standard spreadsheet error strings (mirror formula-parser / formulajs). */
export const ERR = {
  NA: '#N/A',
  VALUE: '#VALUE!',
  NAME: '#NAME?',
  NUM: '#NUM!',
  REF: '#REF!',
  DIV0: '#DIV/0!',
}
const ERR_SET = new Set(Object.values(ERR))

/** Is v one of the spreadsheet error sentinels? (so we propagate, not swallow) */
export function isErr(v: unknown): boolean {
  return typeof v === 'string' && ERR_SET.has(v)
}

/**
 * flatten — turn any argument (scalar, 1-D, or 2-D range array) into a flat
 * list of scalar values, row-major. Ranges from the parser are `[[..],[..]]`.
 */
export function flatten(arg: FormulaArg, out: CellScalar[] = []): CellScalar[] {
  if (Array.isArray(arg)) {
    for (const v of arg) flatten(v, out)
  } else {
    out.push(arg)
  }
  return out
}

/** Coerce to a boolean the spreadsheet way (numbers: 0=false; strings TRUE/FALSE). */
export function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') {
    const s = v.trim().toUpperCase()
    if (s === 'TRUE') return true
    if (s === 'FALSE' || s === '') return false
    const n = Number(s)
    return isFinite(n) ? n !== 0 : true
  }
  return !!v
}

// A formula operand is always string/number/boolean; anything else has no
// meaningful scalar form, so it gets '' rather than String()'s
// "[object Object]" (which could produce two dissimilar non-primitives
// spuriously comparing equal).
function scalarStr(v: unknown): string {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : ''
}

/** Loose scalar equality used by lookup/match (number-aware, case-insensitive). */
export function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  const an = Number(a), bn = Number(b)
  if (isFinite(an) && isFinite(bn) && scalarStr(a).trim() !== '' && scalarStr(b).trim() !== '') {
    return an === bn
  }
  if (a == null || b == null) return false
  return scalarStr(a).toLowerCase() === scalarStr(b).toLowerCase()
}

/** Escape a string for safe use as a literal inside a RegExp. */
function escapeRe(s: unknown): string {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Numeric coercion; returns NaN when not a finite number. */
function num(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return isFinite(n) ? n : NaN
  }
  return NaN
}

/** Compare two scalars for SORT/XMATCH (numbers before strings; case-insensitive). */
export function compareScalar(a: unknown, b: unknown): number {
  const an = num(a), bn = num(b)
  const aNum = !Number.isNaN(an), bNum = !Number.isNaN(bn)
  if (aNum && bNum) return an - bn
  if (aNum) return -1
  if (bNum) return 1
  return String(a).toLowerCase() < String(b).toLowerCase() ? -1
    : String(a).toLowerCase() > String(b).toLowerCase() ? 1 : 0
}

// ── TEXTJOIN(delimiter, ignore_empty, ...text) ──────────────────────────────
// Joins all text arguments (and ranges) with a delimiter, optionally skipping
// empty values. Excel/Sheets semantics.
export function TEXTJOIN(params: FormulaArg[]): CellScalar {
  if (!Array.isArray(params) || params.length < 2) return ERR.NA
  const [delimiter, ignoreEmptyRaw, ...rest] = params
  const delim = delimiter == null ? '' : String(delimiter)
  const ignoreEmpty = toBool(ignoreEmptyRaw)
  const vals = flatten(rest)
  const out: string[] = []
  for (const v of vals) {
    if (isErr(v)) return v
    const s = v == null ? '' : String(v)
    if (ignoreEmpty && s === '') continue
    out.push(s)
  }
  return out.join(delim)
}

// ── IFS(cond1, val1, cond2, val2, ...) ──────────────────────────────────────
// Returns the value for the first TRUE condition. #N/A if none match.
export function IFS(params: FormulaArg[]): CellScalar {
  if (!Array.isArray(params) || params.length < 2) return ERR.NA
  for (let i = 0; i + 1 < params.length; i += 2) {
    const cond = params[i]
    if (isErr(cond)) return cond as unknown as CellScalar
    if (toBool(cond)) return params[i + 1] as CellScalar
  }
  return ERR.NA
}

// ── SWITCH(expr, case1, val1, [case2, val2, ...], [default]) ────────────────
// Matches expr against each case; returns matching value or the optional
// trailing default. #N/A if no match and no default.
export function SWITCH(params: FormulaArg[]): CellScalar {
  if (!Array.isArray(params) || params.length < 3) return ERR.NA
  const expr = params[0]
  if (isErr(expr)) return expr as unknown as CellScalar
  const rest = params.slice(1)
  let i = 0
  for (; i + 1 < rest.length; i += 2) {
    if (looseEqual(expr, rest[i])) return rest[i + 1] as CellScalar
  }
  // A trailing lone argument is the default.
  if (i < rest.length) return rest[i] as CellScalar
  return ERR.NA
}

// ── XLOOKUP(lookup, lookup_array, return_array, [if_not_found], [match_mode]) ─
// A modern lookup: searches lookup_array for lookup and returns the aligned
// value from return_array. match_mode: 0 exact (default), -1 exact-or-next
// -smaller, 1 exact-or-next-larger. Falls back to if_not_found (or #N/A).
export function XLOOKUP(params: FormulaArg[]): CellScalar {
  if (!Array.isArray(params) || params.length < 3) return ERR.NA
  const [lookup, lookupArrRaw, returnArrRaw, ifNotFound, matchModeRaw] = params
  if (isErr(lookup)) return lookup as unknown as CellScalar
  const lookupArr = flatten(lookupArrRaw)
  // DATA-INTEGRITY: index the return array BY ROW, not by flattened offset. When
  // the return range is 2-D (multiple columns), a single flatten() interleaves
  // every column, so aligning the match index `i` against the flat list lands on
  // (row 0, col i) instead of the matched ROW — e.g. XLOOKUP("b", A1:A3, B1:C3)
  // wrongly returned C1 rather than B2. returnRows keeps each row intact; with no
  // spill we surface the row's FIRST cell (the leftmost matched value).
  const returnRows = toRows(returnArrRaw)
  const matchMode = Number(matchModeRaw) || 0

  // Excel returns #VALUE! when the lookup and return arrays have different
  // lengths (heights). Silently truncating/misaligning would drop or misreport
  // data with no signal — validate up front and fail loud.
  if (lookupArr.length !== returnRows.length) return ERR.VALUE

  const pick = (i: number): CellScalar => {
    const row = returnRows[i]
    if (i < 0 || i >= returnRows.length) return ERR.REF
    return Array.isArray(row) ? (row.length ? row[0] as CellScalar : ERR.REF) : row
  }

  // Exact match first (always).
  for (let i = 0; i < lookupArr.length; i++) {
    if (looseEqual(lookup, lookupArr[i])) return pick(i)
  }
  // Approximate modes over numeric keys.
  if (matchMode === -1 || matchMode === 1) {
    const target = num(lookup)
    if (!Number.isNaN(target)) {
      let best = -1, bestDelta = Infinity
      for (let i = 0; i < lookupArr.length; i++) {
        const k = num(lookupArr[i])
        if (Number.isNaN(k)) continue
        if (matchMode === -1 && k <= target) {
          const d = target - k
          if (d < bestDelta) { bestDelta = d; best = i }
        } else if (matchMode === 1 && k >= target) {
          const d = k - target
          if (d < bestDelta) { bestDelta = d; best = i }
        }
      }
      if (best >= 0) return pick(best)
    }
  }
  return ifNotFound !== undefined ? (ifNotFound as CellScalar) : ERR.NA
}

// Normalise a range argument into an array of ROWS. A 2-D range arrives as an
// array of row arrays; a 1-D column/row arrives as a flat array (each element is
// its own row); a scalar becomes a single one-row list. Used by XLOOKUP so a
// multi-column return range is aligned by row, not by flattened cell offset.
function toRows(arg: FormulaArg): FormulaArg[] {
  if (!Array.isArray(arg)) return [arg]
  if (arg.length === 0) return []
  return arg.map((r) => (Array.isArray(r) ? r : r))
}

// ── XMATCH(lookup, lookup_array, [match_mode]) ──────────────────────────────
// Returns the 1-based position of lookup within lookup_array. match_mode as
// XLOOKUP. #N/A when not found.
export function XMATCH(params: FormulaArg[]): CellScalar {
  if (!Array.isArray(params) || params.length < 2) return ERR.NA
  const [lookup, lookupArrRaw, matchModeRaw] = params
  if (isErr(lookup)) return lookup as unknown as CellScalar
  const lookupArr = flatten(lookupArrRaw)
  const matchMode = Number(matchModeRaw) || 0
  for (let i = 0; i < lookupArr.length; i++) {
    if (looseEqual(lookup, lookupArr[i])) return i + 1
  }
  if (matchMode === -1 || matchMode === 1) {
    const target = num(lookup)
    if (!Number.isNaN(target)) {
      let best = -1, bestDelta = Infinity
      for (let i = 0; i < lookupArr.length; i++) {
        const k = num(lookupArr[i])
        if (Number.isNaN(k)) continue
        if (matchMode === -1 && k <= target && target - k < bestDelta) { bestDelta = target - k; best = i }
        else if (matchMode === 1 && k >= target && k - target < bestDelta) { bestDelta = k - target; best = i }
      }
      if (best >= 0) return best + 1
    }
  }
  return ERR.NA
}

// ── LET — NOT registered (deferred) ─────────────────────────────────────────
// Excel LET binds names to values then returns a calculation referencing them.
// This is NOT expressible on Fortune-Sheet's parser: the grammar EAGERLY
// evaluates every argument before a function runs and has no lazy-binding hook,
// so the bare name arguments (`x` in `LET(x, 5, x)`) are resolved as unknown
// variables and throw #NAME? BEFORE our function is ever called. Implementing it
// would require forking the parser grammar. LET is therefore intentionally
// omitted from CUSTOM_FUNCTIONS (it cleanly reports #NAME? like any unknown
// function) and listed in the deferred set. The pure helper below is kept only
// as documentation of the intended semantics; it is not wired to the engine.
export function LET(params: FormulaArg[]): CellScalar {
  if (!Array.isArray(params) || params.length < 3) return ERR.NA
  const calc = params[params.length - 1]
  const bindings = new Map<string, FormulaArg>()
  for (let i = 0; i + 1 < params.length - 1; i += 2) {
    const name = params[i]
    if (typeof name === 'string') bindings.set(name, params[i + 1])
  }
  if (typeof calc === 'string' && bindings.has(calc)) return bindings.get(calc) as CellScalar
  return calc as CellScalar
}

// ── FILTER(array, include, [if_empty]) ──────────────────────────────────────
// Dynamic-array FILTER. Fortune-Sheet has no spill, so we return a scalar-safe
// result: a single kept value returns as a scalar; multiple kept values return
// a comma-joined string (visible, non-crashing) — honest about the no-spill
// limitation. `include` is a same-length mask (range of truthy/0).
export function FILTER(params: FormulaArg[]): CellScalar {
  if (!Array.isArray(params) || params.length < 2) return ERR.NA
  const [arrayRaw, includeRaw, ifEmpty] = params
  const arr = flatten(arrayRaw)
  const mask = flatten(includeRaw)
  // DATA-INTEGRITY: Excel requires the INCLUDE mask to be the same height as the
  // array. The old code defaulted every out-of-range mask index to 0 (exclude),
  // so a mask SHORTER than the array silently DROPPED the unmatched tail
  // (FILTER({1;2;3}, {1;1}) returned "1, 2", losing row 3) — a silent data loss.
  // Fail loud with #VALUE! on any length mismatch instead of quietly truncating.
  if (arr.length !== mask.length) return ERR.VALUE
  const kept: CellScalar[] = []
  for (let i = 0; i < arr.length; i++) {
    const m = mask[i]
    // An error in the INCLUDE mask propagates (Excel semantics) — and must not be
    // fed to toBool, which coerces an unrecognised string to true and would
    // silently KEEP the row instead of surfacing the error.
    if (isErr(m)) return m
    if (!toBool(m)) continue
    // Only propagate an error from an INCLUDED row. Previously the isErr check ran
    // on every source element before the mask was consulted, so an error sitting
    // in a FILTERED-OUT row aborted the whole result: FILTER({10;#DIV/0!;30},
    // {1;0;1}) wrongly returned #DIV/0! instead of {10, 30}.
    if (isErr(arr[i])) return arr[i]
    kept.push(arr[i])
  }
  if (kept.length === 0) return ifEmpty !== undefined ? (ifEmpty as CellScalar) : ERR.NA
  if (kept.length === 1) return kept[0]
  return kept.join(', ')
}

// ── SORT(array, [sort_index], [sort_order]) ─────────────────────────────────
// Scalar-safe SORT over a single flattened column/row. sort_order 1 asc
// (default) / -1 desc. Returns a scalar when one value, else a comma-joined
// string (no spill). sort_index is accepted for signature parity but a
// flattened 1-D list has a single column.
export function SORT(params: FormulaArg[]): CellScalar {
  if (!Array.isArray(params) || params.length < 1) return ERR.NA
  const [arrayRaw, , sortOrderRaw] = params
  const arr = flatten(arrayRaw).filter((v) => v !== '' && v != null)
  for (const v of arr) if (isErr(v)) return v
  const order = Number(sortOrderRaw) === -1 ? -1 : 1
  const sorted = [...arr].sort((a, b) => compareScalar(a, b) * order)
  if (sorted.length === 0) return ERR.NA
  if (sorted.length === 1) return sorted[0]
  return sorted.join(', ')
}

// ── UNIQUE(array) ───────────────────────────────────────────────────────────
// Scalar-safe UNIQUE. formulajs ships a UNIQUE but it treats its varargs
// differently (each arg a value); ours accepts a range and de-dupes preserving
// first-seen order. Single value → scalar; else comma-joined (no spill).
export function UNIQUE(params: FormulaArg[]): CellScalar {
  if (!Array.isArray(params) || params.length < 1) return ERR.NA
  const arr = flatten(params[0]).filter((v) => v !== '' && v != null)
  const seen = new Set<string>()
  const out: CellScalar[] = []
  for (const v of arr) {
    if (isErr(v)) return v
    const key = typeof v === 'string' ? v.toLowerCase() : String(v)
    if (!seen.has(key)) { seen.add(key); out.push(v) }
  }
  if (out.length === 0) return ERR.NA
  if (out.length === 1) return out[0]
  return out.join(', ')
}

// ── TEXTBEFORE / TEXTAFTER ───────────────────────────────────────────────────
// Excel text functions @formulajs does NOT ship (verified). Return the text
// before/after the Nth occurrence of a delimiter.
//   TEXTBEFORE(text, delimiter, [instance_num=1], [match_mode=0], [match_end=0], [if_not_found])
//   TEXTAFTER (text, delimiter, [instance_num=1], [match_mode=0], [match_end=0], [if_not_found])
// instance_num<0 counts occurrences from the END (Excel). match_mode=1 is
// case-insensitive. A delimiter not found returns if_not_found, or #N/A.

// Index of the Nth (1-based) occurrence of delim in text, honoring case mode and
// negative n (from the end). Returns -1 when there is no such occurrence.
function nthIndexOf(text: string, delim: string, n: number, insensitive: boolean): number {
  if (delim === '') return -1
  const hay = insensitive ? text.toLowerCase() : text
  const needle = insensitive ? delim.toLowerCase() : delim
  const positions: number[] = []
  let from = 0
  for (;;) {
    const i = hay.indexOf(needle, from)
    if (i < 0) break
    positions.push(i)
    from = i + needle.length
  }
  if (positions.length === 0) return -1
  const idx = n < 0 ? positions.length + n : n - 1
  if (idx < 0 || idx >= positions.length) return -1
  return positions[idx]
}

function textBeforeAfter(params: FormulaArg[], after: boolean): CellScalar {
  if (!Array.isArray(params) || params.length < 2) return ERR.NA
  const [textRaw, delimRaw, instRaw, modeRaw, , ifNotFound] = params
  if (isErr(textRaw)) return textRaw as unknown as CellScalar
  if (isErr(delimRaw)) return delimRaw as unknown as CellScalar
  const text = textRaw == null ? '' : String(textRaw)
  const delim = delimRaw == null ? '' : String(delimRaw)
  const n = instRaw === undefined || instRaw === '' ? 1 : Math.trunc(Number(instRaw))
  if (!Number.isFinite(n) || n === 0) return ERR.VALUE
  const insensitive = Number(modeRaw) === 1
  const at = nthIndexOf(text, delim, n, insensitive)
  if (at < 0) return ifNotFound !== undefined ? (ifNotFound as CellScalar) : ERR.NA
  return after ? text.slice(at + delim.length) : text.slice(0, at)
}

export function TEXTBEFORE(params: FormulaArg[]): CellScalar { return textBeforeAfter(params, false) }
export function TEXTAFTER(params: FormulaArg[]): CellScalar { return textBeforeAfter(params, true) }

// ── TEXTSPLIT(text, col_delimiter, [row_delimiter], [ignore_empty]) ──────────
// Excel dynamic-array split. Fortune-Sheet has no spill, so — like FILTER/SORT —
// a single field returns as a scalar and multiple fields return comma-joined
// (honest about the no-spill limitation). col_delimiter may be a single string or
// a range/array of strings (any of them splits). ignore_empty drops empty fields.
export function TEXTSPLIT(params: FormulaArg[]): CellScalar {
  if (!Array.isArray(params) || params.length < 2) return ERR.NA
  const [textRaw, colDelimRaw, rowDelimRaw, ignoreEmptyRaw] = params
  if (isErr(textRaw)) return textRaw as unknown as CellScalar
  const text = textRaw == null ? '' : String(textRaw)
  const delims = [...flatten(colDelimRaw), ...flatten(rowDelimRaw)]
    .filter((d) => d != null && d !== '')
    .map((d) => String(d))
  if (delims.length === 0) return ERR.VALUE
  const ignoreEmpty = toBool(ignoreEmptyRaw)
  // Split on any of the delimiters. Escape for a safe alternation regex.
  const re = new RegExp(delims.map(escapeRe).join('|'))
  let parts = text.split(re)
  if (ignoreEmpty) parts = parts.filter((p) => p !== '')
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0]
  return parts.join(', ')
}

// ── SEQUENCE(rows, [columns=1], [start=1], [step=1]) ─────────────────────────
// Dynamic-array generator. No spill → scalar-safe: one value returns as a scalar,
// many return comma-joined. The total count is bounded so a hostile SEQUENCE
// (1e9, …) cannot allocate an enormous string.
const MAX_SEQUENCE = 10000
export function SEQUENCE(params: FormulaArg[]): CellScalar {
  if (!Array.isArray(params) || params.length < 1) return ERR.NA
  const rows = Math.trunc(Number(params[0]))
  const cols = params[1] === undefined || params[1] === '' ? 1 : Math.trunc(Number(params[1]))
  const start = params[2] === undefined || params[2] === '' ? 1 : Number(params[2])
  const step = params[3] === undefined || params[3] === '' ? 1 : Number(params[3])
  if (!Number.isFinite(rows) || !Number.isFinite(cols) || rows < 1 || cols < 1) return ERR.VALUE
  if (!Number.isFinite(start) || !Number.isFinite(step)) return ERR.VALUE
  const total = rows * cols
  if (total > MAX_SEQUENCE) return ERR.NUM
  const out: number[] = []
  for (let i = 0; i < total; i++) out.push(start + i * step)
  if (out.length === 1) return out[0]
  return out.join(', ')
}

// ── SORTBY(array, by_array, [sort_order=1]) ──────────────────────────────────
// Sort `array` by the aligned values of `by_array` (1 asc / -1 desc). Scalar-safe
// like SORT: one value → scalar, many → comma-joined. A length mismatch fails loud
// with #VALUE! rather than silently dropping/misaligning rows.
export function SORTBY(params: FormulaArg[]): CellScalar {
  if (!Array.isArray(params) || params.length < 2) return ERR.NA
  const arr = flatten(params[0])
  const by = flatten(params[1])
  const order = Number(params[2]) === -1 ? -1 : 1
  if (arr.length !== by.length) return ERR.VALUE
  for (const v of arr) if (isErr(v)) return v
  for (const v of by) if (isErr(v)) return v
  const idx = arr.map((_, i) => i)
  idx.sort((a, b) => compareScalar(by[a], by[b]) * order)
  const sorted = idx.map((i) => arr[i]).filter((v) => v !== '' && v != null)
  if (sorted.length === 0) return ERR.NA
  if (sorted.length === 1) return sorted[0]
  return sorted.join(', ')
}

// ── Registry ────────────────────────────────────────────────────────────────
// Names we own. Each is `(params:Array) => value`. The parser calls with a
// single params array (see argument-shape note above).
// NOTE: LET is intentionally absent — Fortune-Sheet's eager grammar makes it
// non-functional at the engine level (see the LET comment above). Registering it
// would falsely advertise support while still returning #NAME?.
export const CUSTOM_FUNCTIONS: Record<string, (params: FormulaArg[]) => CellScalar> = {
  TEXTJOIN,
  IFS,
  SWITCH,
  XLOOKUP,
  XMATCH,
  FILTER,
  SORT,
  UNIQUE,
  // Newly added — all verified ABSENT from @formulajs (so they never shadow a
  // built-in) and all pure, scalar-safe (honest no-spill) data transforms.
  TEXTBEFORE,
  TEXTAFTER,
  TEXTSPLIT,
  SEQUENCE,
  SORTBY,
}

export type CustomFormula = (params: FormulaArg[]) => CellScalar

export interface FormulaParserPrototype {
  getFunction?: (name: string) => CustomFormula | undefined
  __vulosCustomFormulasInstalled?: boolean
  [key: string]: unknown
}

export interface FormulaParserClass {
  prototype: FormulaParserPrototype
}

/**
 * installCustomFormulas — idempotently wrap the formula-parser Parser so every
 * instance the core constructs resolves our custom functions. Safe to call many
 * times (guarded). Accepts the Parser class so the caller controls the exact
 * module instance (avoids duplicate-module surprises under bundling/tests).
 *
 * We wrap `getFunction` (checked first in `_callFunction`) so we NEVER shadow a
 * name we don't own: if the original resolver already has the function, we defer
 * to it; only otherwise do we answer for names in CUSTOM_FUNCTIONS. Built-in
 * formulajs functions still resolve through the untouched fall-through path.
 */
export function installCustomFormulas(ParserClass: FormulaParserClass | null | undefined): boolean {
  if (!ParserClass || !ParserClass.prototype) return false
  const proto = ParserClass.prototype
  if (proto.__vulosCustomFormulasInstalled) return true
  const original = proto.getFunction
  proto.getFunction = function patchedGetFunction(this: unknown, name: string) {
    const own = original ? original.call(this, name) : undefined
    if (own) return own
    const up = typeof name === 'string' ? name.toUpperCase() : ''
    const fn = CUSTOM_FUNCTIONS[up]
    return fn || undefined
  }
  proto.__vulosCustomFormulasInstalled = true
  return true
}
