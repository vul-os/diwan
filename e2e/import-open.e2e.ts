/**
 * Import "Open" flow E2E (CAPSTONE) — the unified drag-drop / file-picker Open
 * flow that routes a real Office/ODF file through its importer into the right
 * app, in a real browser. This exercises the WHOLE ingress seam end-to-end:
 * AppHome file picker → importFile() → detectType routing → the real importer
 * (mammoth for .docx; the xlsx reader; our hand-rolled pptx/odt/ods parsers) →
 * api.createFile (mocked) → navigate to the destination editor → content lands.
 *
 * Fixtures are REAL packages built in-test (JSZip OOXML/ODF + the xlsx writer),
 * not stubs, so the importers do genuine work. A hostile fixture proves the
 * sanitiser trust boundary neutralises active content on the way in.
 *
 * The mocked backend (fixtures.js) now serves POST /files (createFile): it stores
 * the imported content and returns an id, and the destination editor GETs it back
 * — so what the importer produced is exactly what the editor renders.
 */

import { test, expect, type OfficePage } from './fixtures.js'
import JSZip from 'jszip'
import * as XLSX from 'xlsx'

// The hostile-import test sets this from injected markup IF the sanitiser
// fails closed; the assertion is that it never fires. Typed as `number | boolean`
// to agree with e2e/docs-structured.e2e.ts's augmentation of the same ambient
// Window property (see that file for why).
declare global {
  interface Window {
    __pwned?: number | boolean
  }
}

interface FilePayload {
  name: string
  mimeType: string
  buffer: Buffer
}

// ── Fixture builders (real packages) ────────────────────────────────────────
async function makeDocx(bodyText: string): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml',
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`)
  zip.file('_rels/.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)
  zip.file('word/document.xml',
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
    `<w:p><w:r><w:t>${bodyText}</w:t></w:r></w:p></w:body></w:document>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}

// xlsx's own types declare write()'s return as `any` (types/index.d.ts) for
// every bookType/output combination — this asserts the concrete type its own
// docs promise for `type: 'array'` (a Uint8Array), rather than letting that
// `any` propagate into these functions' declared Buffer return type.
function makeXlsx(cellText: string): Buffer {
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet([[cellText, 42], ['row2', 7]])
  XLSX.utils.book_append_sheet(wb, ws, 'Data')
  return Buffer.from(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as Uint8Array)
}

function makeOds(cellText: string): Buffer {
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet([[cellText, 1], ['b', 2]])
  XLSX.utils.book_append_sheet(wb, ws, 'Data')
  return Buffer.from(XLSX.write(wb, { bookType: 'ods', type: 'array' }) as Uint8Array)
}

async function makePptx(text: string): Promise<Buffer> {
  const slideXml = `<?xml version="1.0"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
 <p:cSld><p:spTree>
  <p:sp>
   <p:spPr><a:xfrm><a:off x="838200" y="365760"/><a:ext cx="10515600" cy="1325563"/></a:xfrm></p:spPr>
   <p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody>
  </p:sp>
 </p:spTree></p:cSld>
</p:sld>`
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types/>')
  zip.file('ppt/presentation.xml',
    `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
    `<p:sldSz cx="12192000" cy="6858000"/></p:presentation>`)
  zip.file('ppt/slides/slide1.xml', slideXml)
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }))
}

async function makeOdt(text: string): Promise<Buffer> {
  const NS = [
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
  ].join(' ')
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${NS}>
  <office:body><office:text><text:p>${text}</text:p></office:text></office:body>
</office:document-content>`
  const zip = new JSZip()
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text')
  zip.file('content.xml', content)
  return zip.generateAsync({ type: 'nodebuffer' })
}

// Drive the unified Open flow: land on the given app home, feed the file to the
// hidden picker input, and let importFile() route + navigate.
async function openViaPicker(page: OfficePage, home: string, file: FilePayload): Promise<void> {
  await page.goto(home)
  // The hidden picker input is the real readiness signal (and setInputFiles works
  // on it directly). We wait for it rather than the "Open file" button, which is
  // rendered twice — the toolbar "Open file" plus an empty-state "Open File" that
  // appears once the (empty) files list resolves — an intermittent strict-mode
  // ambiguity that has nothing to do with the import under test.
  const input = page.locator('input[type="file"]')
  await input.waitFor({ state: 'attached', timeout: 30_000 })
  await input.setInputFiles(file)
}

test.describe('Import Open flow — real fixtures land in the right app (CAPSTONE E2E)', () => {
  test('.docx opens in Docs with its text', async ({ officePage: page }) => {
    const buffer = await makeDocx('Hello Doc Body')
    await openViaPicker(page, '/docs', { name: 'memo.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer })
    await page.waitForURL(/\/docs\/file_/, { timeout: 30_000 })
    await expect(page.locator('.ProseMirror')).toContainText('Hello Doc Body', { timeout: 30_000 })
  })

  test('.odt opens in Docs with its text', async ({ officePage: page }) => {
    const buffer = await makeOdt('ODT Imported Text')
    await openViaPicker(page, '/docs', { name: 'note.odt', mimeType: 'application/vnd.oasis.opendocument.text', buffer })
    await page.waitForURL(/\/docs\/file_/, { timeout: 30_000 })
    await expect(page.locator('.ProseMirror')).toContainText('ODT Imported Text', { timeout: 30_000 })
  })

  test('.xlsx opens in Sheets', async ({ officePage: page }) => {
    const buffer = makeXlsx('ImportedHeader')
    await openViaPicker(page, '/sheets', { name: 'budget.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer })
    await page.waitForURL(/\/sheets\/file_/, { timeout: 30_000 })
    // Routed to Sheets: the editor mounts with the imported file's name as title.
    // (The heavy fortune-sheet grid render is E2E-covered in sheets-slides.e2e.js;
    // here the URL + mounted title are the import-landed-in-Sheets proof, and keep
    // this test off the canvas-mount timing that flakes under full-suite load.)
    await expect(page.getByLabel('Sheet title')).toHaveValue('budget', { timeout: 30_000 })
  })

  test('.ods opens in Sheets', async ({ officePage: page }) => {
    const buffer = makeOds('OdsHeader')
    await openViaPicker(page, '/sheets', { name: 'ledger.ods', mimeType: 'application/vnd.oasis.opendocument.spreadsheet', buffer })
    await page.waitForURL(/\/sheets\/file_/, { timeout: 30_000 })
    await expect(page.getByLabel('Sheet title')).toHaveValue('ledger', { timeout: 30_000 })
  })

  test('.pptx opens in Slides with its text box', async ({ officePage: page }) => {
    const buffer = await makePptx('PPTX Imported Text')
    await openViaPicker(page, '/slides', { name: 'deck.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer })
    await page.waitForURL(/\/slides\/file_/, { timeout: 30_000 })
    await expect(page.getByLabel('Presentation title')).toHaveValue('deck', { timeout: 30_000 })
    // The imported slide's positioned text object carries the source text.
    await expect(page.locator('.vslide-object').filter({ hasText: 'PPTX Imported Text' }).first())
      .toBeVisible({ timeout: 30_000 })
  })

  test('cross-app routing: a .xlsx dropped on the Docs home still opens in Sheets', async ({ officePage: page }) => {
    const buffer = makeXlsx('CrossRouted')
    // Feed a spreadsheet through the DOCS home picker — detectType must route it
    // to Sheets regardless of which home it was opened from.
    await openViaPicker(page, '/docs', { name: 'stray.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer })
    await page.waitForURL(/\/sheets\/file_/, { timeout: 30_000 })
    await expect(page.getByLabel('Sheet title')).toHaveValue('stray', { timeout: 30_000 })
  })

  test('a hostile document is neutralised on import — no script executes', async ({ officePage: page }) => {
    // An .html file routes to Docs; its raw markup is UNTRUSTED and must pass
    // through sanitizeDocHtml (the DocsEditor trust boundary) before TipTap.
    const hostile = '<p>Safe body text</p>'
      + '<img src=x onerror="window.__pwned=true">'
      + '<script>window.__pwned=true</script>'
      + '<a href="javascript:window.__pwned=true">click</a>'
    const buffer = Buffer.from(hostile, 'utf-8')

    await openViaPicker(page, '/docs', { name: 'evil.html', mimeType: 'text/html', buffer })
    await page.waitForURL(/\/docs\/file_/, { timeout: 30_000 })
    await expect(page.locator('.ProseMirror')).toContainText('Safe body text', { timeout: 30_000 })

    // Nothing executed, and the active vectors are gone from the live DOM.
    await page.waitForTimeout(300)
    expect(await page.evaluate(() => window.__pwned)).toBeFalsy()
    await expect(page.locator('.ProseMirror script')).toHaveCount(0)
    await expect(page.locator('.ProseMirror img[onerror]')).toHaveCount(0)
    await expect(page.locator('.ProseMirror a[href^="javascript:"]')).toHaveCount(0)
  })
})
