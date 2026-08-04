/**
 * src/apps/sheets/odsChartsRead.ts
 *
 * DETECT charts + pivot tables in an imported .ods (OpenDocument Spreadsheet) so
 * their loss is HONEST, never silent.
 *
 * THE DATA LOSS THIS CLOSES. SheetJS reads .ods CELLS but exposes nothing about
 * an .ods chart or DataPilot (pivot) — and, unlike the .xlsx path, Vulos has no
 * reader that turns an .ods chart into a live Vulos chart. So opening a
 * chart-bearing .ods gave a workbook with the cells and NO charts, and
 * re-exporting it wrote a file with no charts either: the exact silent
 * round-trip data loss the .xlsx path already fixed with importNotes. This module
 * is the .ods half — it does NOT try to import the charts (it cannot), it COUNTS
 * them so importWorkbook can record the loss and the export dialog can restate it.
 *
 * HOW (a real, observable signal). An .ods is a ZIP (JSZip is already a
 * dependency). Two canonical signals, both defined by the OpenDocument spec:
 *   - CHARTS: every embedded chart object is a directory file-entry in
 *     META-INF/manifest.xml with media-type
 *     "application/vnd.oasis.opendocument.chart". Counting those entries counts
 *     the charts (the per-object content.xml/preview entries carry other
 *     media-types, so they are not double-counted).
 *   - PIVOTS: a DataPilot table is a <table:data-pilot-table> element in
 *     content.xml. Counting those counts the pivots.
 *
 * SECURITY. The file is untrusted. The whole package is already size-gated by
 * assertFileSize before this runs (see workbookToSheets). We additionally skip a
 * part whose declared uncompressed size is implausibly large (a zip-bomb belt),
 * count with a bounded scan, and clamp the reported counts. Nothing here is
 * eval'd, nothing builds HTML, no external entity is expanded (we string-match a
 * couple of well-known markers rather than DOM-parsing arbitrary XML).
 */
import JSZip from 'jszip'

export interface OdsObjectCounts {
  charts: number
  pivots: number
}

/** JSZip's private `_data.uncompressedSize` — undocumented but present on
 * objects loaded via `loadAsync`. JSZip's own .d.ts keeps this commented out
 * pending a public API (see the note above its `interface CompressedObject`),
 * so we reach it through a local extension of the shipped `JSZipObject` type. */
interface JSZipEntryWithPrivateData extends JSZip.JSZipObject {
  _data?: { uncompressedSize?: number }
}

const CHART_MIME = 'application/vnd.oasis.opendocument.chart'
// A single part larger than this (uncompressed) is not scanned — a belt against a
// zip-bomb hiding behind the package-level size gate. content.xml for a normal
// spreadsheet is far smaller.
const MAX_PART_BYTES = 16 * 1024 * 1024
// No honest spreadsheet has more than this many charts/pivots; clamp the count so
// a crafted manifest cannot drive an enormous importNotes list.
const MAX_COUNT = 500

/** Uncompressed size of a JSZip entry when JSZip exposes it, else null. */
function uncompressedSize(entry: JSZip.JSZipObject | null | undefined): number | null {
  const n = (entry as JSZipEntryWithPrivateData | null | undefined)?._data?.uncompressedSize
  return Number.isFinite(n) ? (n as number) : null
}

async function readCapped(entry: JSZip.JSZipObject | null | undefined): Promise<string> {
  if (!entry) return ''
  const size = uncompressedSize(entry)
  if (size != null && size > MAX_PART_BYTES) return '' // zip-bomb belt
  const text = await entry.async('string')
  return text.length > MAX_PART_BYTES ? '' : text
}

/**
 * readOdsObjects — count the charts + pivot tables an .ods package carries.
 * @returns { charts:number, pivots:number } (both clamped, never negative)
 * Never throws: a package we cannot open, or a part we cannot read, yields 0 for
 * that signal rather than failing the whole import (the cells still arrive).
 */
export async function readOdsObjects(bytes: Parameters<typeof JSZip.loadAsync>[0]): Promise<OdsObjectCounts> {
  const empty: OdsObjectCounts = { charts: 0, pivots: 0 }
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes)
  } catch {
    return empty
  }

  let charts = 0
  try {
    const manifest = await readCapped(zip.file('META-INF/manifest.xml'))
    if (manifest) {
      // Count file-entries whose media-type is the chart mimetype. Prefix-agnostic
      // on the attribute name; tolerant of single/double quotes and whitespace.
      const re = /media-type\s*=\s*["']application\/vnd\.oasis\.opendocument\.chart["']/g
      charts = (manifest.match(re) || []).length
    }
  } catch { /* charts stays 0 */ }

  let pivots = 0
  try {
    const content = await readCapped(zip.file('content.xml'))
    if (content) {
      pivots = (content.match(/<[a-zA-Z0-9]*:?data-pilot-table[\s/>]/g) || []).length
    }
  } catch { /* pivots stays 0 */ }

  return {
    charts: Math.min(Math.max(charts, 0), MAX_COUNT),
    pivots: Math.min(Math.max(pivots, 0), MAX_COUNT),
  }
}
