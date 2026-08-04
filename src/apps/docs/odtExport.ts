/**
 * odtExport.js — best-effort TipTap document → OpenDocument Text (.odt).
 * ----------------------------------------------------------------------------
 * `docx` (the library we already ship) has no ODT writer, and there is no light
 * odt-writer package, so we emit a minimal-but-valid ODF package by hand: the
 * required `mimetype` (stored first, uncompressed, per spec), a `META-INF/
 * manifest.xml`, `styles.xml`, and a `content.xml` built from the editor JSON.
 *
 * FIDELITY IS HONEST-PARTIAL: paragraphs, headings (outline levels), bold /
 * italic / underline / strike runs, bullet & ordered lists, and simple tables
 * round-trip. Colour, font family/size, images, equations, footnotes, headers/
 * footers and page geometry are NOT written here (the DOCX and HTML exporters
 * carry those) — the ODT path targets clean, editable content in LibreOffice.
 * Everything written is escaped; no user string becomes markup.
 */

import { saveAs } from 'file-saver'
import JSZip from 'jszip'
import type { Editor, JSONContent } from '@tiptap/react'
import { escapeXmlText } from '../../lib/xmlText.js'

// Escape for ODF content.xml. escapeXmlText FIRST strips XML-1.0-illegal control
// chars (VT/FF/NUL/…) that would otherwise make LibreOffice reject the .odt, THEN
// escapes the five XML metacharacters. See src/lib/xmlText.js.
function esc(s: unknown): string {
  return escapeXmlText(s)
}

// Wrap escaped text in the nested spans for whichever marks are present. Each
// mark maps to a single automatic style declared in content.xml's styles block.
function runXml(node: JSONContent): string {
  if (node.type !== 'text') return ''
  let text = esc(node.text || '')
  const marks = (node.marks || []).map((m) => m.type)
  const wrap = (styleName: string, inner: string) => `<text:span text:style-name="${styleName}">${inner}</text:span>`
  if (marks.includes('bold')) text = wrap('T-Bold', text)
  if (marks.includes('italic')) text = wrap('T-Italic', text)
  if (marks.includes('underline')) text = wrap('T-Underline', text)
  if (marks.includes('strike')) text = wrap('T-Strike', text)
  return text
}

function inlineXml(nodes: JSONContent[] | undefined): string {
  return (nodes || []).map(runXml).join('')
}

const HEADING_STYLE: Record<number, string> = { 1: 'Heading_20_1', 2: 'Heading_20_2', 3: 'Heading_20_3', 4: 'Heading_20_4', 5: 'Heading_20_5', 6: 'Heading_20_6' }

function listXml(node: JSONContent): string {
  const items = (node.content || []).map((item) => {
    const parts = (item.content || []).map((child) => {
      if (child.type === 'bulletList' || child.type === 'orderedList') return listXml(child)
      return `<text:p>${inlineXml(child.content || [])}</text:p>`
    })
    return `<text:list-item>${parts.join('')}</text:list-item>`
  })
  return `<text:list>${items.join('')}</text:list>`
}

function tableXml(node: JSONContent): string {
  const rows = (node.content || []).map((row) => {
    const cells = (row.content || []).map((cell) => {
      const paras = (cell.content || []).map((p) => `<text:p>${inlineXml(p.content || [])}</text:p>`).join('')
      return `<table:table-cell office:value-type="string">${paras || '<text:p/>'}</table:table-cell>`
    })
    return `<table:table-row>${cells.join('')}</table:table-row>`
  })
  const nCols = Math.max(1, ...(node.content || []).map((r) => (r.content || []).length))
  return `<table:table table:name="Table"><table:table-column table:number-columns-repeated="${nCols}"/>${rows.join('')}</table:table>`
}

function blockXml(node: JSONContent): string {
  switch (node.type) {
    case 'heading': {
      const lvl = Math.min(Math.max(node.attrs?.level || 1, 1), 6)
      return `<text:h text:style-name="${HEADING_STYLE[lvl]}" text:outline-level="${lvl}">${inlineXml(node.content || [])}</text:h>`
    }
    case 'paragraph':
      return `<text:p>${inlineXml(node.content || [])}</text:p>`
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return listXml(node)
    case 'blockquote':
      return (node.content || []).map(blockXml).join('')
    case 'codeBlock':
      return `<text:p text:style-name="Preformatted_20_Text">${esc((node.content || []).map((n) => n.text).join(''))}</text:p>`
    case 'table':
      return tableXml(node)
    case 'horizontalRule':
      return '<text:p/>'
    default:
      return ''
  }
}

// content.xml automatic + named styles used above.
const STYLES_DECL = `
  <office:automatic-styles>
    <style:style style:name="T-Bold" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>
    <style:style style:name="T-Italic" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>
    <style:style style:name="T-Underline" style:family="text"><style:text-properties style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"/></style:style>
    <style:style style:name="T-Strike" style:family="text"><style:text-properties style:text-line-through-style="solid"/></style:style>
  </office:automatic-styles>`

const NS = [
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"',
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"',
  'xmlns:xlink="http://www.w3.org/1999/xlink"',
].join(' ')

/** Build the .odt package as a Blob (pure — no download side effect). */
export async function buildOdtBlob(editor: Editor): Promise<Blob> {
  const json = editor.getJSON()
  const body = (json.content || []).map(blockXml).join('')
  const contentXml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${NS} office:version="1.2">${STYLES_DECL}
  <office:body><office:text>${body || '<text:p/>'}</office:text></office:body>
</office:document-content>`

  const stylesXml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles ${NS} office:version="1.2">
  <office:styles>
    <style:style style:name="Standard" style:family="paragraph" style:class="text"/>
    <style:style style:name="Heading_20_1" style:display-name="Heading 1" style:family="paragraph" style:parent-style-name="Standard"><style:text-properties fo:font-size="24pt" fo:font-weight="bold"/></style:style>
    <style:style style:name="Heading_20_2" style:display-name="Heading 2" style:family="paragraph" style:parent-style-name="Standard"><style:text-properties fo:font-size="18pt" fo:font-weight="bold"/></style:style>
    <style:style style:name="Heading_20_3" style:display-name="Heading 3" style:family="paragraph" style:parent-style-name="Standard"><style:text-properties fo:font-size="14pt" fo:font-weight="bold"/></style:style>
    <style:style style:name="Preformatted_20_Text" style:display-name="Preformatted Text" style:family="paragraph"><style:text-properties style:font-name="Courier New"/></style:style>
  </office:styles>
</office:document-styles>`

  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
  <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`

  const zip = new JSZip()
  // The `mimetype` entry MUST be first and STORED (uncompressed) per ODF spec.
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' })
  zip.file('content.xml', contentXml)
  zip.file('styles.xml', stylesXml)
  const metaInf = zip.folder('META-INF')
  if (!metaInf) throw new Error('odtExport: failed to create META-INF folder in zip')
  metaInf.file('manifest.xml', manifest)
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.oasis.opendocument.text' })
}

export async function exportToOdt(editor: Editor, filename: string): Promise<void> {
  const blob = await buildOdtBlob(editor)
  saveAs(blob, `${filename}.odt`)
}
