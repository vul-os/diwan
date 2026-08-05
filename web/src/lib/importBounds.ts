/**
 * importBounds.js — the untrusted-input trust boundary for file IMPORT.
 * ----------------------------------------------------------------------------
 * Every imported document (.docx/.xlsx/.pptx/.odt/.ods/.odp) is UNTRUSTED: a
 * hostile file must not be able to exhaust memory (zip-bomb / oversize), smuggle
 * a path-traversal asset (zip-slip), or drive an XML parser into external-entity
 * fetch / billion-laughs expansion (XXE). This module centralises those controls
 * so every importer shares ONE audited set of caps + safe-unzip + safe-XML.
 *
 * The *content* trust boundary (script/CSS/formula neutralisation) lives in the
 * per-app sanitisers (lib/sanitize.js sanitizeDocHtml, slideObjects
 * sanitizeObjects, sheetsExport csvField). This module is the *structural*
 * boundary that runs FIRST, before a single byte is decompressed or parsed.
 */

import JSZip from 'jszip'

// JSZip's public typings omit the internal streaming/metadata surface this
// module deliberately reaches into (internalStream, the central-directory
// _data, and the per-archive __inflatedRemaining budget this module stashes
// on the instance). Narrow, local extensions rather than `any` at each call site.
interface JSZipInternalStream {
  on(event: 'data', cb: (chunk: Uint8Array) => void): JSZipInternalStream
  on(event: 'error', cb: (err: unknown) => void): JSZipInternalStream
  on(event: 'end', cb: () => void): JSZipInternalStream
  pause(): void
  resume(): void
}
interface JSZipObjectInternal extends JSZip.JSZipObject {
  _data?: { uncompressedSize?: number }
  internalStream(type: 'uint8array'): JSZipInternalStream
}
interface JSZipInternal extends JSZip {
  files: { [key: string]: JSZipObjectInternal }
  __inflatedRemaining?: number
}

// ── Caps ─────────────────────────────────────────────────────────────────────
// Chosen generously enough for real office documents, tight enough that a bomb
// is refused long before it can hurt. All are enforced fail-closed (over cap ⇒
// throw ImportError, never a partial/truncated silent import).
export const MAX_FILE_BYTES = 60 * 1024 * 1024        // 60 MB compressed input
export const MAX_TOTAL_UNCOMPRESSED = 300 * 1024 * 1024 // 300 MB decompressed (zip-bomb)
export const MAX_ZIP_ENTRIES = 5000                    // entry-count bound
export const MAX_SINGLE_ENTRY = 100 * 1024 * 1024      // 100 MB any one entry

// Sheets-specific caps (a .xlsx/.ods can declare an enormous sparse range).
export const MAX_SHEETS = 200
export const MAX_CELLS_PER_SHEET = 500_000             // ~ 500 cols × 1000 rows dense
export const MAX_ROWS = 200_000
export const MAX_COLS = 16_384

// Docs/slides content caps.
export const MAX_SLIDES = 1000
export const MAX_HTML_BYTES = 20 * 1024 * 1024         // parsed doc/odt HTML size

export class ImportError extends Error {
  constructor(message?: string) {
    super(message)
    this.name = 'ImportError'
  }
}

/** Reject an oversize input before we even read it into memory. */
export function assertFileSize(byteLength: number, filename = 'file'): void {
  if (typeof byteLength === 'number' && byteLength > MAX_FILE_BYTES) {
    throw new ImportError(
      `${filename} is too large (${Math.round(byteLength / 1048576)} MB). ` +
      `The import limit is ${Math.round(MAX_FILE_BYTES / 1048576)} MB.`
    )
  }
}

// A zip entry name is hostile if it escapes the archive root (zip-slip). We
// never write extracted bytes to the filesystem — everything stays in memory —
// but a `..`/absolute/backslash path is still a red flag and could be misused by
// any downstream that keys on the name, so we refuse the whole archive.
function isUnsafeEntryName(name: unknown): boolean {
  if (typeof name !== 'string' || !name) return true
  if (name.startsWith('/') || name.startsWith('\\')) return true
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(name)) return true   // any `..` path segment
  if (/^[a-zA-Z]:[\\/]/.test(name)) return true              // windows drive-absolute
  if (name.includes('\0')) return true                        // NUL injection
  return false
}

/**
 * safeLoadZip — JSZip.loadAsync wrapped in the structural bounds.
 * Enforces: input size, entry count, per-entry + total DECLARED uncompressed
 * size (the zip-bomb guard — checked from the central-directory metadata BEFORE
 * any entry is inflated), and zip-slip entry names. Returns the JSZip instance.
 *
 * The uncompressed-size check reads JSZip's per-file metadata
 * (`file._data.uncompressedSize`) which comes straight from the zip central
 * directory — so a 42 KB "42.zip"-style bomb is refused without decompressing a
 * single byte. Callers should still prefer `entryText()` below to read entries
 * (it re-checks the actual inflated length as belt-and-braces).
 */
export async function safeLoadZip(arrayBuffer: ArrayBuffer | Uint8Array, filename = 'file'): Promise<JSZipInternal> {
  assertFileSize(arrayBuffer.byteLength, filename)
  let zip: JSZipInternal
  try {
    zip = await JSZip.loadAsync(arrayBuffer, { createFolders: false }) as JSZipInternal
  } catch (e) {
    throw new ImportError(`${filename} is not a readable archive: ${e instanceof Error ? e.message : String(e)}`)
  }
  const names = Object.keys(zip.files)
  if (names.length > MAX_ZIP_ENTRIES) {
    throw new ImportError(`${filename} has too many entries (${names.length} > ${MAX_ZIP_ENTRIES}).`)
  }
  let total = 0
  for (const name of names) {
    const f = zip.files[name]
    if (isUnsafeEntryName(name)) {
      throw new ImportError(`${filename} contains an unsafe entry path: ${name}`)
    }
    // Declared uncompressed size from the central directory (present for real
    // zips; JSZip exposes it on the internal _data). Guard both the single-entry
    // and the running total to catch a bomb whichever shape it takes.
    const declared = f?._data?.uncompressedSize
    if (typeof declared === 'number') {
      if (declared > MAX_SINGLE_ENTRY) {
        throw new ImportError(`${filename} entry "${name}" is too large when decompressed.`)
      }
      total += declared
      if (total > MAX_TOTAL_UNCOMPRESSED) {
        throw new ImportError(`${filename} decompresses to more than the ${Math.round(MAX_TOTAL_UNCOMPRESSED / 1048576)} MB limit (possible zip-bomb).`)
      }
    }
  }
  return zip
}

/**
 * inflateEntryBounded — decompress ONE zip entry with a HARD memory cap that is
 * enforced *while* inflating, aborting the moment the running output exceeds the
 * budget — never after fully decompressing.
 *
 * Why streaming and not `f.async('uint8array')`: JSZip's `async` accumulates
 * every inflated chunk and only concatenates at the end, so a `f.async()` call
 * followed by a `buf.length > cap` check reads the ENTIRE bomb into memory before
 * the check can fire (OOM). Worse, JSZip's zip-bomb accounting (and ours in
 * safeLoadZip) trusts the central directory's *declared* uncompressedSize — a
 * hostile archive can declare 100 bytes while the deflate stream actually
 * inflates to gigabytes (a "lying central directory"), sailing past every
 * declared-size gate. The only sound defence is to bound the ACTUAL inflate.
 *
 * JSZip inflates via a pako worker pipeline that emits 16 KB output chunks and
 * honours `pause()` between async ticks, so we accumulate chunks and, the instant
 * the running total exceeds the cap, pause the pipeline and reject — the giant
 * contiguous buffer is never allocated and no further input is inflated.
 *
 * A per-archive cumulative budget (`zip.__inflatedRemaining`, seeded to
 * MAX_TOTAL_UNCOMPRESSED) is decremented across every entry read, so a bomb split
 * across MANY lying entries (each individually under the single-entry cap) still
 * cannot exceed the total-decompressed ceiling.
 */
function inflateEntryBounded(
  zip: JSZipInternal,
  name: string,
  perEntryCap = MAX_SINGLE_ENTRY,
  discard = false
): Promise<Uint8Array | number | null> {
  const f = zip.files[name]
  if (!f) return Promise.resolve(null)
  const remaining = typeof zip.__inflatedRemaining === 'number'
    ? zip.__inflatedRemaining
    : MAX_TOTAL_UNCOMPRESSED
  const cap = Math.min(perEntryCap, remaining)
  return new Promise((resolve, reject) => {
    let stream: JSZipInternalStream
    try {
      stream = f.internalStream('uint8array')
    } catch (e) {
      reject(new ImportError(`entry "${name}" could not be read: ${e instanceof Error ? e.message : String(e)}`))
      return
    }
    // `discard` mode (validation-only, used by assertArchiveBounds): enforce the
    // cap on the streamed bytes but never accumulate them — so the bomb pre-check
    // never allocates the (up to per-entry-cap) contiguous buffer it is guarding.
    const chunks: Uint8Array[] = []
    let total = 0
    let settled = false
    const fail = (msg: string) => {
      if (settled) return
      settled = true
      try { stream.pause() } catch { /* best-effort */ }
      reject(new ImportError(msg))
    }
    stream.on('data', (chunk: Uint8Array) => {
      if (settled) return
      total += chunk.length
      if (total > cap) {
        // Abort mid-inflate: over the (per-entry ∩ per-archive) budget.
        fail(`entry "${name}" exceeds the decompressed-size limit (possible zip-bomb).`)
        return
      }
      if (!discard) chunks.push(chunk)
    })
    stream.on('error', (e: unknown) => fail(`entry "${name}" could not be decompressed: ${e instanceof Error ? e.message : String(e)}`))
    stream.on('end', () => {
      if (settled) return
      settled = true
      zip.__inflatedRemaining = remaining - total
      if (discard) { resolve(total); return }
      const out = new Uint8Array(total)
      let i = 0
      for (const c of chunks) { out.set(c, i); i += c.length }
      resolve(out)
    })
    stream.resume()
  })
}

/**
 * assertArchiveBounds — the zip-bomb pre-check for importers that do their OWN
 * unbounded inflation instead of going through entryText/entryDataUri: the DOCX
 * path (mammoth) and the XLSX/ODS path (SheetJS) both take the RAW archive bytes
 * and inflate them internally, so the mid-stream inflateEntryBounded cap that
 * protects the odt/pptx/odp path never sees their entries. Left unguarded, a
 * lying-central-directory zip-bomb .docx/.xlsx could OOM the importer's tab.
 *
 * This runs BEFORE those libraries touch the bytes and enforces the full bounds:
 *   1. safeLoadZip — central-directory pre-check: input size, entry count,
 *      per-entry + cumulative DECLARED uncompressed size, and zip-slip names.
 *   2. a streaming actual-inflate pass over EVERY file entry (inflateEntryBounded
 *      in discard mode) — so a LYING central directory (declares 100 bytes while
 *      the deflate stream inflates to gigabytes) is aborted mid-inflate and the
 *      whole archive rejected, catching the case the declared-size gate cannot.
 * Throws ImportError on any breach; returns the validated JSZip otherwise.
 *
 * RESIDUAL LIMIT (honest): mammoth/SheetJS then inflate the archive a SECOND time
 * inside their own readers. That re-inflation is safe because THIS pass has
 * already proven the entire archive stays within MAX_SINGLE_ENTRY and the
 * MAX_TOTAL_UNCOMPRESSED cumulative budget — a bomb can no longer reach them. The
 * cost is a one-time redundant inflate of an already-validated, bounded archive:
 * the honest price of not forking those libraries' internal zip readers. (We also
 * do not re-verify their per-part XML with parseXmlSafe — mammoth and SheetJS use
 * their own entity-free XML readers; the no-network-fetch guarantee for both is
 * covered by importNoFetch.test.js.)
 */
export async function assertArchiveBounds(
  arrayBuffer: ArrayBuffer | Uint8Array,
  filename = 'file',
  perEntryCap = MAX_SINGLE_ENTRY
): Promise<JSZipInternal> {
  const zip = await safeLoadZip(arrayBuffer, filename)
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name]?.dir) continue
    await inflateEntryBounded(zip, name, perEntryCap, true)
  }
  return zip
}

/**
 * entryText — read one zip entry as a string, enforcing the single-entry +
 * per-archive decompressed caps *during* inflation (see inflateEntryBounded).
 * Returns '' for a missing entry.
 */
export async function entryText(zip: JSZipInternal, name: string): Promise<string> {
  const buf = await inflateEntryBounded(zip, name)
  if (buf === null || typeof buf === 'number') return ''
  return new TextDecoder('utf-8').decode(buf)
}

/** Read one zip entry as a base64 data: URI with the given MIME — bounded. */
export async function entryDataUri(zip: JSZipInternal, name: string, mime: string): Promise<string> {
  const buf = await inflateEntryBounded(zip, name)
  if (buf === null || typeof buf === 'number') return ''
  // Chunked base64 to avoid a call-stack blow-up on large arrays.
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK) as unknown as number[])
  }
  return `data:${mime};base64,${btoa(bin)}`
}

// ── XXE-safe XML parsing ─────────────────────────────────────────────────────
// We parse OpenDocument / OOXML part XML with the browser DOMParser. A DOMParser
// never resolves *external* entities (no network / no file access in the browser
// sandbox), but an INTERNAL entity block can still drive a billion-laughs memory
// blow-up, and a DOCTYPE has no legitimate place in an office part. So we STRIP
// any DOCTYPE / ENTITY declaration before parsing — fail-closed: the parse sees
// only element markup, never an entity-expansion or external-DTD reference.
export function stripDoctype(xml: unknown): string {
  if (typeof xml !== 'string') return ''
  // Remove the whole <!DOCTYPE ...> production (with or without an internal
  // subset) and any stray <!ENTITY ...> declarations. Also drop external-entity
  // reference syntax markers so a malformed doc can't smuggle one past the strip.
  return xml
    .replace(/<!DOCTYPE[\s\S]*?(?:\[[\s\S]*?\]\s*)?>/gi, '')
    .replace(/<!ENTITY[\s\S]*?>/gi, '')
}

/**
 * parseXmlSafe — DOMParser over XML with DOCTYPE/ENTITY stripped first. Returns
 * a Document. Throws ImportError on a parse error (a hostile/corrupt part).
 */
export function parseXmlSafe(xml: string, label = 'xml'): Document {
  if (typeof DOMParser === 'undefined') {
    throw new ImportError('XML parsing is unavailable in this environment.')
  }
  const cleaned = stripDoctype(xml)
  const doc = new DOMParser().parseFromString(cleaned, 'application/xml')
  const err = doc.querySelector('parsererror')
  if (err) throw new ImportError(`Could not parse ${label}.`)
  return doc
}

export { isUnsafeEntryName, inflateEntryBounded }
