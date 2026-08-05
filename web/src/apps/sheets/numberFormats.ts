/**
 * src/apps/sheets/numberFormats.ts
 *
 * Cell number-format presets (currency / percent / date / …), backed by
 * Fortune Sheet's native `cell.v.ct` format descriptor. Fortune Sheet renders a
 * cell's display value (`m`) from its raw value (`v`) using `ct.fa` (the format
 * string) and `ct.t` (the type tag). We only rewrite this *display metadata* —
 * never the underlying `v` — so applying a format is invisible to CRDT
 * grid-sync (which diffs the raw string value, not `ct`).
 *
 * Format codes follow the standard spreadsheet/Excel number-format grammar,
 * which Fortune Sheet understands.
 */

export interface NumberFormatPreset {
  id: string
  label: string
  fa: string
  t: string
}

export interface FormatDescriptor {
  fa: string
  t: string
}

/** The `{ fa, t, s }` format descriptor Fortune Sheet stamps on a cell's `ct`. */
export interface CellFormat {
  fa?: string
  t?: string
  s?: unknown
}

/** A Fortune-Sheet cell's `v` slot — in practice either a bare scalar or an
 * object carrying `{ v, m, ct, ... }`; celldata entries seen in the wild use
 * both shapes, which is looser than Fortune Sheet's own shipped `Cell` type. */
export type CellValue = string | number | boolean | null | undefined | CellObject

export interface CellObject {
  v?: string | number | boolean
  m?: string | number
  ct?: CellFormat
  [key: string]: unknown
}

export interface CellEntry {
  r: number
  c: number
  v: CellValue
  [key: string]: unknown
}

export interface SheetData {
  celldata?: CellEntry[]
  [key: string]: unknown
}

// Preset id → { label, sample fmt code, ct.t type }. `General` clears any format.
export const NUMBER_FORMAT_PRESETS: NumberFormatPreset[] = [
  { id: 'general',    label: 'Automatic',       fa: 'General',            t: 'g' },
  { id: 'number',     label: 'Number',          fa: '#,##0.00',           t: 'n' },
  { id: 'number_int', label: 'Number (no dec.)',fa: '#,##0',              t: 'n' },
  { id: 'percent',    label: 'Percent',         fa: '0.00%',              t: 'n' },
  { id: 'currency',   label: 'Currency ($)',    fa: '"$"#,##0.00',        t: 'n' },
  { id: 'currency_eur', label: 'Currency (€)',  fa: '"€"#,##0.00',        t: 'n' },
  { id: 'accounting', label: 'Accounting',      fa: '_("$"* #,##0.00_)',  t: 'n' },
  { id: 'scientific', label: 'Scientific',      fa: '0.00E+00',           t: 'n' },
  { id: 'date',       label: 'Date',            fa: 'yyyy-mm-dd',         t: 'd' },
  { id: 'datetime',   label: 'Date time',       fa: 'yyyy-mm-dd hh:mm:ss',t: 'd' },
  { id: 'time',       label: 'Time',            fa: 'hh:mm:ss',           t: 'd' },
  { id: 'text',       label: 'Plain text',      fa: '@',                  t: 's' },
]

export function presetById(id: string): NumberFormatPreset | null {
  return NUMBER_FORMAT_PRESETS.find((p) => p.id === id) || null
}

/**
 * ctForPreset — the `ct` descriptor to stamp onto a cell for a preset. Returns
 * null for `general` (meaning: clear any custom format back to automatic).
 */
export function ctForPreset(id: string): FormatDescriptor | null {
  const p = presetById(id)
  if (!p || p.id === 'general') return null
  return { fa: p.fa, t: p.t }
}

/**
 * normalizeCellObject — Fortune Sheet cells can be a bare scalar or a
 * `{ v, m, ct }` object. Return a mutable object form without losing the value.
 */
export function normalizeCellObject(v: CellValue): CellObject {
  if (v && typeof v === 'object') return { ...v }
  if (v === null || v === undefined) return { v: '', m: '' }
  return { v, m: String(v) }
}

/**
 * applyNumberFormat — stamp a number-format preset across every cell of an
 * inclusive 0-indexed rectangle on the first sheet, returning a NEW workbook
 * array. Only touches cells' `ct` (and re-derives nothing about `v`), so raw
 * values — and therefore CRDT sync — are untouched.
 *
 * Cells that don't exist yet in celldata are left alone (no value to format);
 * we don't want to create empty cells just to carry a format they can't show.
 */
export function applyNumberFormat(
  data: SheetData[],
  rowRange: [number, number],
  colRange: [number, number],
  presetId: string,
): SheetData[] {
  const ct = ctForPreset(presetId)
  const [r0, r1] = rowRange
  const [c0, c1] = colRange
  const inRange = (r: number, c: number) => r >= r0 && r <= r1 && c >= c0 && c <= c1

  return data.map((sheet, idx) => {
    if (idx !== 0) return sheet
    const celldata = (sheet.celldata || []).map((cell) => {
      if (!inRange(cell.r, cell.c)) return cell
      const v = normalizeCellObject(cell.v)
      if (ct) {
        v.ct = { ...(v.ct || {}), fa: ct.fa, t: ct.t }
      } else if (v.ct) {
        // Automatic → drop the custom format, revert the type to generic.
        v.ct = { fa: 'General', t: 'g' }
      }
      return { ...cell, v }
    })
    return { ...sheet, celldata }
  })
}

/**
 * detectPresetId — best-effort reverse lookup so the picker can highlight the
 * current cell's format. Falls back to 'general'.
 */
export function detectPresetId(cellV: CellValue): string {
  const fa = cellV && typeof cellV === 'object' ? cellV.ct?.fa : null
  if (!fa || fa === 'General') return 'general'
  const hit = NUMBER_FORMAT_PRESETS.find((p) => p.fa === fa)
  return hit ? hit.id : 'general'
}
