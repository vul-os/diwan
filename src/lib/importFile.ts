import { marked } from 'marked'
import mammoth from 'mammoth'
import type { NavigateFunction } from 'react-router-dom'
import { api } from './api'
import { useFilesStore } from '../store/filesStore'
import { assertFileSize, assertArchiveBounds, ImportError } from './importBounds'
import { importWorkbook } from '../apps/sheets/sheetsImport'
import { csvToSheet } from '../apps/sheets/csvImport'
import { odtToHtml } from '../apps/docs/odtImport'
import { pptxToSlides, odpToSlides } from '../apps/slides/slidesImport'
import { sanitizeObjects } from '../apps/slides/slideObjects'

export type DocType = 'doc' | 'sheet' | 'slide' | 'pdf'
type CreatedFile = { id: string; [key: string]: unknown }

// ── Format detection / routing ────────────────────────────────────────────────
// Every supported inbound format maps to exactly one app. The unified Open flow
// (file-picker + drag-drop) calls detectType() to pick the importer + route.
export const SUPPORTED_EXTS = [
  'md', 'txt', 'doc', 'docx', 'rtf', 'html', 'htm', 'odt',   // docs
  'xlsx', 'xls', 'csv', 'tsv', 'ods',                        // sheets
  'pptx', 'ppt', 'odp',                                      // slides
  'pdf',                                                     // pdf
]

// Extensions we can genuinely OPEN with real fidelity (used by the Open dialog's
// accept filter). Legacy binary .doc/.xls/.ppt are intentionally excluded — see
// the deferred note; they fall through to a plain-text/no-op path if forced.
export const OPENABLE_ACCEPT =
  '.md,.txt,.docx,.rtf,.html,.htm,.odt,.xlsx,.xls,.csv,.tsv,.ods,.pptx,.odp,.pdf'

export function detectType(filename: string): DocType | null {
  const ext = (filename.split('.').pop() || '').toLowerCase()
  if (['md', 'txt', 'doc', 'docx', 'rtf', 'html', 'htm', 'odt'].includes(ext)) return 'doc'
  if (['xlsx', 'xls', 'csv', 'tsv', 'ods'].includes(ext)) return 'sheet'
  if (['pptx', 'ppt', 'odp'].includes(ext)) return 'slide'
  if (ext === 'pdf') return 'pdf'
  return null
}

export function typeToRoute(type: string): string | null {
  if (type === 'doc') return 'docs'
  if (type === 'sheet') return 'sheets'
  if (type === 'slide') return 'slides'
  return null
}

/** Human-facing "we can't open this" message for an unsupported extension. */
export function unsupportedMessage(filename: string): string {
  const ext = (filename.split('.').pop() || '').toLowerCase()
  if (['doc', 'xls', 'ppt'].includes(ext)) {
    return `Legacy binary .${ext} files aren't supported yet — please re-save as ` +
      `.${ext}x (or ODF) and try again.`
  }
  return `Cannot open .${ext} files.`
}

// ── Low-level readers ─────────────────────────────────────────────────────────

async function fileToText(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsText(file)
  })
}

async function fileToArrayBuffer(file: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = reject
    reader.readAsArrayBuffer(file)
  })
}

// ── Docs ──────────────────────────────────────────────────────────────────────
// All doc importers return `{ type:'doc', _html }` — and `_html` is UNTRUSTED.
// DocsEditor.resolveContent runs it through sanitizeDocHtml before it reaches
// TipTap (the trust boundary), so no script / on*-handler / javascript: href /
// non-raster data: image / dangerous inline-style survives the import.

// mammoth options: extract embedded images to INLINE base64 data: URIs (its
// default convertImage is images.dataUri). Crucially this means NO network fetch
// on import — an <img src="http://tracker"> in the source .docx is not created
// by mammoth (it only emits data: URIs for embedded binary parts). Remote refs
// in the source are dropped rather than fetched.
const MAMMOTH_OPTS = {
  convertImage: mammoth.images.imgElement((image) =>
    image.readAsBase64String().then((b64) => ({ src: `data:${image.contentType};base64,${b64}` }))
  ),
}

async function docFromText(text: string) {
  const paragraphs = String(text).split(/\n\n+/).map((para) => ({
    type: 'paragraph',
    content: para.trim() ? [{ type: 'text', text: para.replace(/\n/g, ' ').trim() }] : [],
  }))
  return { type: 'doc', content: paragraphs.length ? paragraphs : [{ type: 'paragraph' }] }
}

async function convertDocFromBuffer(ext: string, buf: ArrayBuffer | null, text?: string) {
  if (ext === 'md') return { type: 'doc', _html: await marked.parse(text || ''), content: [{ type: 'paragraph' }] }
  if (ext === 'html' || ext === 'htm') return { type: 'doc', _html: text, content: [{ type: 'paragraph' }] }
  if (ext === 'txt') return docFromText(text || '')
  if (ext === 'docx') {
    if (!buf) throw new ImportError('document is missing its bytes')
    assertFileSize(buf.byteLength, 'document')
    // Zip-bomb guard BEFORE mammoth's own unbounded inflate: reject a lying-CD /
    // oversize .docx while it is still a validated, bounded archive (see
    // assertArchiveBounds). mammoth then re-inflates safe, capped bytes.
    await assertArchiveBounds(buf, 'document')
    const result = await mammoth.convertToHtml({ arrayBuffer: buf }, MAMMOTH_OPTS)
    return { type: 'doc', _html: result.value || '<p></p>', content: [{ type: 'paragraph' }] }
  }
  if (ext === 'odt') {
    if (!buf) throw new ImportError('document is missing its bytes')
    const html = await odtToHtml(buf, 'document.odt')
    return { type: 'doc', _html: html, content: [{ type: 'paragraph' }] }
  }
  // rtf / legacy .doc / unknown → plain-text best-effort.
  return docFromText(text || '')
}

export async function convertToDocContent(file: File) {
  const ext = (file.name.split('.').pop() || '').toLowerCase()
  // Binary formats need the ArrayBuffer; text formats need the decoded text.
  if (['docx', 'odt'].includes(ext)) {
    return convertDocFromBuffer(ext, await fileToArrayBuffer(file))
  }
  const text = await fileToText(file)
  return convertDocFromBuffer(ext, null, text)
}

// ── Sheets ──────────────────────────────────────────────────────────────────

export async function convertToSheetContent(file: File) {
  const ext = (file.name.split('.').pop() || '').toLowerCase()
  if (ext === 'csv' || ext === 'tsv') {
    const text = await fileToText(file)
    const base = file.name.replace(/\.[^.]+$/, '')
    return [csvToSheet(text, base || 'Sheet1', ext === 'tsv' ? '\t' : ',')]
  }
  // xlsx / xls / ods
  const buf = await fileToArrayBuffer(file)
  // .xlsx and .ods are zip archives that SheetJS inflates itself — run the
  // zip-bomb pre-check before handing raw bytes to it (see assertArchiveBounds).
  // Legacy .xls is an OLE compound binary, not a zip, so it is not archive-checked
  // here (its SheetJS parse stays bounded by the file-size gate + cell caps in
  // importWorkbook's cell reader).
  if (ext === 'xlsx' || ext === 'ods') {
    await assertArchiveBounds(buf, file.name)
  }
  // importWorkbook = cells + the parts SheetJS cannot see (real OOXML charts, and
  // whether the file held pivot tables). A chart-bearing .xlsx opened here used to
  // arrive with its charts silently gone; now they come in, and anything that
  // genuinely could not be imported is recorded on the workbook (importNotes) so
  // the export dialog can say so before the user writes over their original.
  const { sheets } = await importWorkbook(buf, file.name)
  return sheets
}

// ── Slides ────────────────────────────────────────────────────────────────────
// Imported decks carry positioned objects[]; sanitize every object at import
// (script/CSS/href + geometry clamp) so nothing untrusted is ever persisted raw.
async function convertToSlideContent(file: File) {
  const ext = (file.name.split('.').pop() || '').toLowerCase()
  const buf = await fileToArrayBuffer(file)
  const deck = ext === 'odp' ? await odpToSlides(buf, file.name) : await pptxToSlides(buf, file.name)
  // sanitizeObjects' inferred (JS) return shape and the importer's inferred
  // per-format object union agree at runtime (both are "positioned slide
  // object" records) but are structurally distinct types as TS infers them
  // from plain JS — an assertion here, not a behaviour change.
  deck.slides = deck.slides.map((s) => ({ ...s, objects: sanitizeObjects(s.objects || []) })) as typeof deck.slides
  return deck
}

// ── PDF ────────────────────────────────────────────────────────────────────────
async function stashPdf(file: File, name: string) {
  const buf = await fileToArrayBuffer(file)
  assertFileSize(buf.byteLength, name)
  sessionStorage.setItem('pendingPDF', JSON.stringify({
    name,
    data: btoa(String.fromCharCode(...new Uint8Array(buf).slice(0, 10 * 1024 * 1024))),
  }))
}

// ── Public: import a File (picker / drag-drop) ──────────────────────────────────

export async function importFile(file: File, navigate: NavigateFunction): Promise<void> {
  assertFileSize(file.size, file.name)
  const type = detectType(file.name)

  if (type === 'pdf') {
    await stashPdf(file, file.name)
    navigate('/pdf-editor')
    return
  }
  if (!type) throw new ImportError(unsupportedMessage(file.name))

  const baseName = file.name.replace(/\.[^.]+$/, '')
  let content: unknown
  if (type === 'doc') content = await convertToDocContent(file)
  else if (type === 'sheet') content = await convertToSheetContent(file)
  else if (type === 'slide') content = await convertToSlideContent(file)

  const created = await api.createFile(baseName, type, content) as CreatedFile
  useFilesStore.setState({ files: [created, ...useFilesStore.getState().files.filter((f: CreatedFile) => f.id !== created.id)] })
  navigate(`/${typeToRoute(type)}/${created.id}`)
}

// ── Public: import a backend-served local file (local scan) ─────────────────────
// Wraps the fetched bytes in a File so it flows through the SAME importers +
// bounds as a drag-dropped file — one code path, one trust boundary.

export async function importFromUrl(
  localFile: { name: string; path: string; appType: string },
  navigate: NavigateFunction
): Promise<void> {
  const { name, path, appType } = localFile
  const baseName = name.replace(/\.[^.]+$/, '')
  const url = api.localFileUrl(path)

  if (appType === 'pdf') {
    sessionStorage.setItem('pendingPDF', JSON.stringify({ name, url }))
    navigate('/pdf-editor')
    return
  }

  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) throw new Error('Failed to fetch file')
  const buf = await res.arrayBuffer()
  const pseudoFile = new File([buf], name)

  let content: unknown
  if (appType === 'doc') content = await convertToDocContent(pseudoFile)
  else if (appType === 'sheet') content = await convertToSheetContent(pseudoFile)
  else if (appType === 'slide') content = await convertToSlideContent(pseudoFile)
  else throw new ImportError(unsupportedMessage(name))

  const created = await api.createFile(baseName, appType, content) as CreatedFile
  useFilesStore.setState({ files: [created, ...useFilesStore.getState().files.filter((f: CreatedFile) => f.id !== created.id)] })
  navigate(`/${typeToRoute(appType)}/${created.id}`)
}
