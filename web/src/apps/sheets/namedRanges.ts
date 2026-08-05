/**
 * src/apps/sheets/namedRanges.ts  (WAVE-63)
 *
 * Named ranges → formula usability.
 *
 * Fortune-Sheet's formula grammar has no native named-range binding: a bare
 * identifier in a formula is not resolved against a name table (we verified a
 * registered parser variable does not resolve for arbitrary names). The engine
 * DOES, however, resolve a `SheetName!A1:B2` reference (verified — cross-sheet
 * refs work). So the tractable, honest way to make a named range usable in a
 * formula is to EXPAND the name to its underlying `Sheet!range` reference in the
 * formula text before it is committed to the cell.
 *
 * `expandNamedRanges` does exactly that: given a formula string and the list of
 * `{ name, range, sheetName }` definitions, it substitutes each whole-word,
 * identifier-boundary occurrence of a name with `'Sheet Name'!range` (quoting
 * the sheet name only when it needs quoting). It is:
 *   - word-boundary safe   — `myRange` inside `myRangeExtra` is NOT touched
 *   - string-literal safe   — a name inside a "quoted string" is NOT touched
 *   - reference safe        — a name already qualified (preceded by `!`) is left
 *   - injection-free        — pure text substitution over an allow-listed name
 *                             pattern; never evals, never builds HTML
 *
 * SECURITY: names are validated by the panel to `[A-Za-z_][A-Za-z0-9_]*`. This
 * function additionally only substitutes names matching that identifier shape,
 * so a malformed/hostile entry cannot rewrite arbitrary formula syntax.
 */

export interface NamedRangeDef {
  name: string
  range: string
  sheetName?: string
}

/** A sheet-like record carrying the app's `namedRanges` extension (not part of
 * Fortune-Sheet's own `Sheet` type — stored as extra metadata on the first sheet). */
export interface SheetWithNamedRanges {
  namedRanges?: NamedRangeDef[]
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Does a sheet name need single-quoting in an A1 reference? */
function needsQuote(name: string): boolean {
  return !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
}

/** Build the `Sheet!range` (or `'Sheet Name'!range`) replacement reference. */
function toRef(def: NamedRangeDef): string {
  const sheet = def.sheetName || ''
  const range = String(def.range || '').trim()
  if (!sheet) return range
  const q = needsQuote(sheet) ? `'${sheet.replace(/'/g, "''")}'` : sheet
  return `${q}!${range}`
}

interface CodeSegment { code: string; str?: undefined }
interface StringSegment { str: string; code?: undefined }
type FormulaSegment = CodeSegment | StringSegment

/**
 * Split a formula into an alternating list of [outsideString, stringLiteral, …]
 * so substitution only touches code, never the inside of a "quoted string".
 * Handles doubled quotes ("" escape) the spreadsheet way.
 */
function splitByStrings(formula: string): FormulaSegment[] {
  const parts: FormulaSegment[] = []
  let buf = ''
  let i = 0
  const n = formula.length
  while (i < n) {
    const ch = formula[i]
    if (ch === '"') {
      // flush code segment
      parts.push({ code: buf }); buf = ''
      let str = '"'
      i++
      while (i < n) {
        if (formula[i] === '"' && formula[i + 1] === '"') { str += '""'; i += 2; continue }
        if (formula[i] === '"') { str += '"'; i++; break }
        str += formula[i]; i++
      }
      parts.push({ str })
    } else {
      buf += ch; i++
    }
  }
  if (buf) parts.push({ code: buf })
  return parts
}

/**
 * expandNamedRanges(formula, namedRanges) — replace each named-range identifier
 * in the formula's CODE segments with its `Sheet!range` reference.
 *
 * Returns the expanded formula string (leading `=` preserved). Idempotent for
 * formulas with no matching names. Longest names first so a name that is a
 * prefix of another doesn't partially match.
 */
export function expandNamedRanges(formula: string, namedRanges: NamedRangeDef[]): string {
  if (typeof formula !== 'string' || !formula) return formula
  if (!Array.isArray(namedRanges) || namedRanges.length === 0) return formula

  // Only well-formed defs, longest-name-first for greedy correctness.
  const defs = namedRanges
    .filter((d) => d && typeof d.name === 'string' && IDENT_RE.test(d.name) && d.range)
    .sort((a, b) => b.name.length - a.name.length)
  if (defs.length === 0) return formula

  // Boundary chars: a name match is only valid when the char BEFORE it is not an
  // identifier char / `!` (already sheet-qualified) / `.`, and the char AFTER is
  // not an identifier char or `(` (a function call). We do this WITHOUT a regex
  // lookbehind (unsupported on Safari < 16.4 — it throws at construction), by
  // checking the boundary chars manually around each `g`-scan match.
  const before = (ch: string | undefined) => ch === undefined || !/[A-Za-z0-9_!.]/.test(ch)
  const after = (ch: string | undefined) => ch === undefined || !/[A-Za-z0-9_(]/.test(ch)

  const parts = splitByStrings(formula)
  const out = parts.map((p) => {
    if (p.str !== undefined) return p.str // never touch a string literal
    let code = p.code
    for (const def of defs) {
      const re = new RegExp(escapeRe(def.name), 'g')
      code = code.replace(re, (m: string, offset: number, whole: string) =>
        before(whole[offset - 1]) && after(whole[offset + m.length]) ? toRef(def) : m
      )
    }
    return code
  })
  return out.join('')
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Read named ranges off the workbook (stored on the first sheet). */
export function getNamedRanges(data: SheetWithNamedRanges[] | undefined | null): NamedRangeDef[] {
  const arr = data?.[0]?.namedRanges
  return Array.isArray(arr) ? arr : []
}
