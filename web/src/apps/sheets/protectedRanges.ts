/**
 * src/apps/sheets/protectedRanges.ts
 *
 * SHEETS PROTECTED RANGES — Google-parity, identity-based warn / restrict.
 *
 * A protected range names a rectangle on a sheet plus a policy:
 *   { id, sheetIndex, name, range:{startRow,startCol,endRow,endCol}, warningOnly, editors:[account…] }
 *
 *   - warningOnly=true  → advisory. The client WARNS before an edit; nothing is
 *     blocked (Google's "show a warning" protection).
 *   - warningOnly=false → RESTRICTED. Only the file OWNER or an account in
 *     `editors` may change a cell inside the rectangle. This is enforced
 *     SERVER-SIDE, fail-closed (backend/handlers/protected_ranges.go) — the client
 *     warning here is only a courtesy; the server is the authority.
 *
 * There are NO passwords and NO encryption (that is Excel's model, deliberately
 * NOT built): protection maps straight onto the existing per-file ACL identities.
 *
 * STORAGE. Like namedRanges / importNotes, the list rides on the FIRST sheet
 * (data[0].protectedRanges) so it persists with the content and survives reload.
 * FortuneSheet's onChange drops app-owned fields, so it is re-attached after every
 * grid edit (mergeProtectedRanges) — without that it would evaporate on the first
 * keystroke.
 *
 * TRUST. The notes ride inside untrusted saved content, so every field is
 * re-clamped on load (makeProtectedRange): ids/names are length-capped plain text,
 * indices are non-negative integers, editors is a bounded list of plain strings.
 * They are advisory metadata — never a formula, never HTML, never eval'd; the
 * panel renders them as escaped text. Nothing here is a security boundary on its
 * own; the server enforcement is.
 */

export interface ProtectedRangeRect {
  startRow: number
  startCol: number
  endRow: number
  endCol: number
}

export interface ProtectedRange {
  id: string
  sheetIndex: number
  name: string
  range: ProtectedRangeRect
  warningOnly: boolean
  editors: string[]
}

/** Loose, pre-validation input to `makeProtectedRange` — any field may arrive
 * as anything (a corrupt file, a hostile peer op), which is what the clamp is for. */
export type ProtectedRangeInput = {
  id?: unknown
  sheetIndex?: unknown
  name?: unknown
  range?: unknown
  warningOnly?: unknown
  editors?: unknown
}

export interface PRSheet {
  protectedRanges?: ProtectedRange[] | undefined
  [key: string]: unknown
}

export interface CellProtection {
  id: string
  name: string
  warningOnly: boolean
  restricted: boolean
  canEdit: boolean
}

const MAX_RANGES = 200
const MAX_EDITORS = 200
const MAX_TEXT = 120

let _seq = 0
export function newProtectedRangeId(): string {
  _seq += 1
  return `pr_${Date.now().toString(36)}_${_seq.toString(36)}`
}

const clampText = (v: unknown): string => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : '')
const clampIdx = (v: unknown): number => {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/** Clamp a raw range rect to non-negative integers with start ≤ end. */
export function clampRect(rect: unknown): ProtectedRangeRect {
  const r = (rect ?? {}) as Record<string, unknown>
  const sr = clampIdx(r.startRow)
  const sc = clampIdx(r.startCol)
  const er = clampIdx(r.endRow)
  const ec = clampIdx(r.endCol)
  return {
    startRow: Math.min(sr, er),
    startCol: Math.min(sc, ec),
    endRow: Math.max(sr, er),
    endCol: Math.max(sc, ec),
  }
}

/**
 * makeProtectedRange — build/clamp one entry. Fail-closed: a malformed editor id
 * is dropped, a missing id is minted, warningOnly coerces to a real boolean.
 */
export function makeProtectedRange(partial: ProtectedRangeInput = {}): ProtectedRange {
  const editors = Array.isArray(partial.editors)
    ? [...new Set(partial.editors.filter((e): e is string => typeof e === 'string' && !!e))].slice(0, MAX_EDITORS)
    : []
  return {
    id: (typeof partial.id === 'string' && partial.id) ? partial.id.slice(0, MAX_TEXT) : newProtectedRangeId(),
    sheetIndex: clampIdx(partial.sheetIndex),
    name: clampText(partial.name),
    range: clampRect(partial.range),
    warningOnly: !!partial.warningOnly,
    editors,
  }
}

/** Read the (unclamped) list off the first sheet. */
export function getProtectedRanges(data: PRSheet[] | null | undefined): ProtectedRange[] {
  const arr = data?.[0]?.protectedRanges
  return Array.isArray(arr) ? arr : []
}

/** Immutably replace the list on the first sheet (empty → drop the field). */
export function setProtectedRanges(data: PRSheet[] | null | undefined, ranges: unknown): PRSheet[] {
  const clean = Array.isArray(ranges) ? ranges.slice(0, MAX_RANGES).map(makeProtectedRange) : []
  return (data || []).map((sheet, idx) => {
    if (idx !== 0) return sheet
    if (!clean.length) {
      if (!sheet?.protectedRanges) return sheet
      const { protectedRanges: _drop, ...rest } = sheet
      return rest
    }
    return { ...sheet, protectedRanges: clean }
  })
}

export function insertProtectedRange(data: PRSheet[] | null | undefined, range: ProtectedRangeInput): PRSheet[] {
  return setProtectedRanges(data, [...getProtectedRanges(data), makeProtectedRange(range)])
}

export function deleteProtectedRange(data: PRSheet[] | null | undefined, id: string): PRSheet[] {
  return setProtectedRanges(data, getProtectedRanges(data).filter((p) => p.id !== id))
}

export function updateProtectedRange(data: PRSheet[] | null | undefined, id: string, patch: ProtectedRangeInput): PRSheet[] {
  return setProtectedRanges(data, getProtectedRanges(data).map((p) =>
    p.id === id ? makeProtectedRange({ ...p, ...patch }) : p))
}

/**
 * clampProtectedRanges — defensively re-clamp on load so a corrupt/legacy/poisoned
 * record can never reach the panel or the merge with an unsafe field. Idempotent.
 */
export function clampProtectedRanges(data: PRSheet[] | null | undefined): PRSheet[] | null | undefined {
  const ranges = getProtectedRanges(data)
  if (!ranges.length) return data
  return setProtectedRanges(data, ranges)
}

/**
 * mergeProtectedRanges — re-attach the list onto the workbook FortuneSheet just
 * normalised (which drops app-owned fields). If the incoming data already carries
 * ranges, they win (an authoritative panel edit).
 */
export function mergeProtectedRanges(nextData: PRSheet[] | null | undefined, ranges: ProtectedRange[] | null | undefined): PRSheet[] | null | undefined {
  if (!Array.isArray(ranges) || !ranges.length) return nextData
  if (!Array.isArray(nextData) || !nextData.length) return nextData
  if (nextData[0]?.protectedRanges) return nextData
  return setProtectedRanges(nextData, ranges)
}

function rectContains(rect: ProtectedRangeRect, r: number, c: number): boolean {
  return r >= rect.startRow && r <= rect.endRow && c >= rect.startCol && c <= rect.endCol
}

/**
 * cellProtection — the protection that applies to (sheetIndex,r,c) for account
 * `me`, or null. Returns { warningOnly, restricted, canEdit, name }:
 *   - restricted → a warningOnly=false range
 *   - canEdit    → me is the owner or listed in editors (so no warning is needed)
 * Used by the editor to warn before an edit the client already knows will be
 * refused (restricted, not canEdit) or is discouraged (warningOnly).
 */
export function cellProtection(
  data: PRSheet[] | null | undefined,
  sheetIndex: number,
  r: number,
  c: number,
  me: string | null | undefined,
  owner: string | null | undefined,
): CellProtection | null {
  const ranges = getProtectedRanges(data).map(makeProtectedRange)
  for (const pr of ranges) {
    if (pr.sheetIndex !== sheetIndex) continue
    if (!rectContains(pr.range, r, c)) continue
    const canEdit = !!(owner && me === owner) || pr.editors.includes(me ?? '')
    return { id: pr.id, name: pr.name, warningOnly: pr.warningOnly, restricted: !pr.warningOnly, canEdit }
  }
  return null
}

/** A1-style label for a rect (e.g. "B2:D10"), for the panel. */
export function rectToA1(rect: ProtectedRangeRect): string {
  const col = (n: number): string => {
    let s = ''
    let x = n
    do { s = String.fromCharCode(65 + (x % 26)) + s; x = Math.floor(x / 26) - 1 } while (x >= 0)
    return s
  }
  const a = `${col(rect.startCol)}${rect.startRow + 1}`
  const b = `${col(rect.endCol)}${rect.endRow + 1}`
  return a === b ? a : `${a}:${b}`
}
