/**
 * src/apps/sheets/importNotes.ts
 *
 * A record of WHAT AN IMPORT COULD NOT BRING IN — carried on the workbook so the
 * app can still be honest about it LATER, at the moment it matters.
 *
 * WHY THIS EXISTS. The dangerous sequence is: open someone's .xlsx → edit a cell
 * → export over the original. Anything the import could not represent (a pivot
 * TABLE, a chart shaped in a way our model can't express) is gone from the
 * workbook by then — so at export time there is nothing left to detect, and the
 * export would look perfectly clean while quietly writing a file that has lost
 * the user's work. Telling them once in a toast at import — which they may not
 * even have been looking at, and which is long gone by the time they export — is
 * not enough. So we REMEMBER, and exportFidelity restates it in the export
 * dialog, before the download, every time.
 *
 * It is a plain-data overlay on the first sheet (like sheet.charts / sheet.pivots),
 * so it persists with the file content and survives a reload. FortuneSheet's
 * onChange drops app-owned fields, so — exactly like charts and pivots — it is
 * merged back after every grid edit (mergeImportNotes); without that, the note
 * would evaporate on the very first keystroke, which is precisely the case it
 * exists to cover.
 *
 * TRUST. The notes ride inside saved file content, so they are re-clamped on load
 * (makeImportNotes): counts are non-negative integers, the reason list is bounded,
 * and every string is length-capped plain text. They are advisory metadata — never
 * a formula, never HTML, never eval'd; the dialog renders them as escaped text.
 */

export interface ImportNoteChart {
  title: string
  reason: string
}

export interface ImportNotes {
  pivots: number
  charts: ImportNoteChart[]
  filename?: string
}

/** Loose, pre-validation input to `makeImportNotes`. */
export interface ImportNotesInput {
  pivots?: unknown
  charts?: unknown
  filename?: unknown
}

export interface INSheet {
  importNotes?: ImportNotes
  [key: string]: unknown
}

const MAX_LISTED = 20
const MAX_TEXT = 160

const clampInt = (v: unknown, max = 10000): number => {
  const n = Math.floor(Number(v))
  return isFinite(n) && n > 0 ? Math.min(n, max) : 0
}
const clampText = (v: unknown): string => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : '')

/**
 * makeImportNotes — build/clamp the record. Returns null when there is nothing to
 * report, so a clean import leaves NO overlay on the workbook at all (and a clean
 * export keeps its zero-friction path).
 */
export function makeImportNotes(partial: ImportNotesInput | null | undefined): ImportNotes | null {
  if (!partial || typeof partial !== 'object') return null
  const pivots = clampInt(partial.pivots)
  const charts = Array.isArray(partial.charts)
    ? partial.charts.slice(0, MAX_LISTED).map((c: { title?: unknown; reason?: unknown }) => ({
        title: clampText(c?.title),
        reason: clampText(c?.reason) || 'it could not be represented',
      }))
    : []
  if (!pivots && !charts.length) return null
  const notes: ImportNotes = { pivots, charts }
  if (typeof partial.filename === 'string' && partial.filename) notes.filename = clampText(partial.filename)
  return notes
}

/** True when the notes describe something the user actually lost. */
export function hasImportLoss(notes: ImportNotes | null | undefined): boolean {
  return !!notes && (notes.pivots > 0 || (Array.isArray(notes.charts) && notes.charts.length > 0))
}

/** Read the (clamped) notes off the first sheet — null when there is nothing. */
export function getImportNotes(data: INSheet[] | null | undefined): ImportNotes | null {
  return makeImportNotes(data?.[0]?.importNotes)
}

/** Immutably attach the notes to the first sheet (null removes them). */
export function setImportNotes(data: INSheet[] | null | undefined, notes: ImportNotesInput | null | undefined): INSheet[] {
  const clean = makeImportNotes(notes)
  return (data || []).map((sheet, idx) => {
    if (idx !== 0) return sheet
    if (!clean) {
      if (!sheet?.importNotes) return sheet
      const { importNotes: _drop, ...rest } = sheet
      return rest
    }
    return { ...sheet, importNotes: clean }
  })
}

/**
 * mergeImportNotes — re-attach notes onto the workbook FortuneSheet just
 * normalised (which drops app-owned fields). Same contract as mergeCharts /
 * mergePivots: if the incoming data already carries notes, they win.
 */
export function mergeImportNotes(nextData: INSheet[] | null | undefined, notes: ImportNotes | null | undefined): INSheet[] | null | undefined {
  if (!hasImportLoss(notes)) return nextData
  if (!Array.isArray(nextData) || !nextData.length) return nextData
  if (nextData[0]?.importNotes) return nextData
  return setImportNotes(nextData, notes)
}

/**
 * combineImportNotes — fold a second import's losses into the workbook's existing
 * ones (importing several files into one workbook). Counts add up; the chart list
 * concatenates (and is re-clamped, so it stays bounded).
 */
export function combineImportNotes(a: ImportNotes | null | undefined, b: ImportNotes | null | undefined): ImportNotes | null {
  if (!hasImportLoss(a)) return makeImportNotes(b)
  if (!hasImportLoss(b)) return makeImportNotes(a)
  return makeImportNotes({
    pivots: (a!.pivots || 0) + (b!.pivots || 0),
    charts: [...(a!.charts || []), ...(b!.charts || [])],
    // Several files contributed — no single filename is honest any more.
    filename: a!.filename && a!.filename === b!.filename ? a!.filename : '',
  })
}

/**
 * importLossSummary — the one-line, plain-English version, for a toast at import.
 * Returns '' when nothing was lost.
 */
export function importLossSummary(notes: ImportNotes | null | undefined): string {
  if (!hasImportLoss(notes) || !notes) return ''
  const bits: string[] = []
  if (notes.charts.length) {
    bits.push(`${notes.charts.length} chart${notes.charts.length === 1 ? '' : 's'} could not be imported`)
  }
  if (notes.pivots) {
    bits.push(`${notes.pivots} pivot table${notes.pivots === 1 ? '' : 's'} came in as plain cells, not as ${notes.pivots === 1 ? 'a live pivot' : 'live pivots'}`)
  }
  return `${bits.join('; ')} — an export from here will not contain them.`
}
