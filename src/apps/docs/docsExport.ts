import { saveAs } from 'file-saver'
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, BorderStyle, ImageRun,
  Header, Footer, PageNumber, AlignmentType, ExternalHyperlink,
  type IRunOptions, type ISectionOptions, type FileChild, type ParagraphChild,
} from 'docx'
import TurndownService from 'turndown'
import type { Editor, JSONContent } from '@tiptap/react'
import { sanitizeDocHtml } from '../../lib/sanitize'
import {
  computeFootnoteOrder, collectFootnoteRefIds, numberFootnotesInHtml,
} from './footnotes.js'
import { renderEquationHtml } from './equation.js'
import { pageSetupToCssAtPage, normalizePageSetup, PAGE_SIZES } from './pageSetup.js'
import { normalizeHeaderFooter, resolveFields, type HeaderFooterBand, type HeaderFooterConfig, type FieldContext } from './headerFooter.js'
import { stripXmlInvalidChars } from '../../lib/xmlText.js'

// DATA-INTEGRITY: every string that becomes <w:t> text must have XML-1.0-illegal
// control chars (VT/FF/NUL/…) removed first — the docx library does NOT strip
// them, so Word would reject/"repair" the exported .docx. Wrap TextRun so ALL run
// text flows through the strip; callers keep passing raw node text. See xmlText.js.
function xr(opts: string | IRunOptions): TextRun {
  if (typeof opts === 'string') return new TextRun(stripXmlInvalidChars(opts))
  if (opts && typeof opts.text === 'string') {
    return new TextRun({ ...opts, text: stripXmlInvalidChars(opts.text) })
  }
  return new TextRun(opts)
}

// P4: Render every math node in an exported HTML string with KaTeX, then hand
// the result through sanitizeDocHtml. The doc HTML carries the LaTeX source in a
// `data-latex` attribute on a `.math-inline` / `.math-block` element (see
// equation.js renderHTML). We render KaTeX (trust:false — no href/script can be
// produced) into those shells so an exported .html file shows real equations,
// then the whole body is sanitised as the trust boundary.
function renderMathInHtml(html: string): string {
  if (typeof html !== 'string' || !html.includes('data-latex')) return html
  if (typeof DOMParser === 'undefined') return html
  try {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
    for (const el of Array.from(doc.querySelectorAll('[data-latex]'))) {
      const latex = el.getAttribute('data-latex') || ''
      const display = el.classList.contains('math-block') || el.getAttribute('data-math') === 'block'
      // renderEquationHtml uses KaTeX trust:false → bounded, script-free markup.
      el.innerHTML = renderEquationHtml(latex, display)
    }
    return doc.body.innerHTML
  } catch {
    return html
  }
}

export interface ExportOptions {
  pageSetup?: unknown
  headerFooter?: unknown
}

// HTML
export function exportToHtml(editor: Editor, filename: string, opts: ExportOptions = {}): void {
  // Bake sequential footnote numbers into the markup (getHTML() alone omits
  // them — they live in an editor decoration, not the document), render math
  // (P4), then sanitise. Order: number footnotes → render KaTeX → sanitise, so
  // the KaTeX markup passes THROUGH the sanitiser (the export trust boundary).
  // WAVE-52: run the exported markup through the doc sanitiser so a downloaded
  // .html file can never carry a script / on*-handler / dangerous cell-style.
  const headings = readHeadingsForExport(editor.getJSON())
  // Footnote-number + ToC baking produce benign text/anchors → run BEFORE the
  // sanitiser (the trust boundary). Equation rendering is done AFTER the
  // sanitiser: the KaTeX shells (`<span data-latex>`) survive sanitisation, and
  // we then paint OUR OWN trusted KaTeX (trust:false, script-free by
  // construction) into them — this preserves KaTeX's dimensional inline styles
  // (e.g. `top` for fraction bars) that the body style allow-list would strip,
  // WITHOUT loosening the shared sanitiser for user-authored content. The math
  // source is still a plain string; nothing user-controlled becomes live markup.
  const sanitized = sanitizeDocHtml(renderTocInHtml(numberFootnotesInHtml(editor.getHTML()), headings))
  const body = renderMathInHtml(sanitized)

  // P3: @page geometry (size/orientation/margins) for print from the HTML file.
  const setup = normalizePageSetup(opts.pageSetup)
  const atPage = pageSetupToCssAtPage(setup)

  // P2: header/footer rendered via CSS paged-media running elements so they
  // repeat on every printed page. Fields resolved to text (page/pages need the
  // print engine for live counts; {{page}}/{{pages}} use CSS counters here).
  const hf = normalizeHeaderFooter(opts.headerFooter)
  const { headerCss, footerCss } = hfToPrintCss(hf, filename)

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(filename)}</title>
<style>
  ${atPage}
  ${headerCss}
  ${footerCss}
  body { font-family: Georgia, serif; max-width: 760px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #1a1a1a; }
  h1, h2, h3, h4, h5, h6 { font-family: system-ui, sans-serif; }
  pre, code { font-family: "Courier New", monospace; background: #f5f5f5; padding: 2px 4px; border-radius: 3px; }
  pre { padding: 12px; overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ddd; padding: 8px; }
  blockquote { border-left: 3px solid #ccc; margin: 0; padding-left: 16px; color: #555; }
  .math-block { text-align: center; margin: 1rem 0; }
  .math-inline { display: inline-block; }
</style>
</head>
<body>
${body}
</body>
</html>`
  saveAs(new Blob([html], { type: 'text/html;charset=utf-8' }), `${filename}.html`)
}

export interface HeadingOutlineEntry {
  level: number
  text: string
  slug: string
}

// P5: bake the live heading outline into each empty ToC shell for export. The
// live ToC node renders via a NodeView (not in getHTML()), so a cold export
// carries only an empty `<div data-toc>`. We fill it with the current outline as
// escaped-text anchors so the exported file shows the ToC. Runs BEFORE the
// sanitiser (the anchors + text are benign; the sanitiser still vets them).
function renderTocInHtml(html: string, headings: HeadingOutlineEntry[]): string {
  if (typeof html !== 'string' || !html.includes('data-toc')) return html
  if (typeof DOMParser === 'undefined') return html
  try {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
    for (const shell of Array.from(doc.querySelectorAll('[data-toc]'))) {
      shell.textContent = ''
      const title = doc.createElement('p')
      title.className = 'toc-title'
      title.textContent = 'Table of Contents'
      shell.appendChild(title)
      for (const h of headings) {
        const a = doc.createElement('a')
        a.setAttribute('href', `#${h.slug}`)
        a.className = 'toc-entry'
        a.style.marginLeft = `${(h.level - 1) * 16}px`
        a.style.display = 'block'
        a.textContent = h.text || '(untitled heading)'
        shell.appendChild(a)
      }
    }
    return doc.body.innerHTML
  } catch {
    return html
  }
}

// Read headings from doc JSON (export doesn't have a live editor state).
function readHeadingsForExport(json: JSONContent): HeadingOutlineEntry[] {
  const out: HeadingOutlineEntry[] = []
  const slugify = (t: unknown) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const textOf = (node: JSONContent): string => {
    let s = ''
    const walk = (n: JSONContent) => {
      if (n.type === 'text') s += n.text || ''
      ;(n.content || []).forEach(walk)
    }
    walk(node)
    return s
  }
  const walk = (n: JSONContent) => {
    if (n.type === 'heading') {
      const text = textOf(n)
      out.push({ level: n.attrs?.level || 1, text, slug: slugify(text) })
    }
    ;(n.content || []).forEach(walk)
  }
  ;(json.content || []).forEach(walk)
  return out
}

// Escape a string for safe interpolation into HTML text (title, header/footer
// text — these are plain strings, not markup). Defence-in-depth: the body is
// sanitised separately; this keeps a title/header from breaking the document
// structure or smuggling markup into <title>/@page running elements.
function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ))
}

// Build @page running-element CSS for headers/footers. {{page}}/{{pages}} map to
// CSS `counter(page)` / `counter(pages)` so the print engine fills real numbers;
// {{title}}/{{date}} are resolved to static (escaped) text at export time.
function hfToPrintCss(hf: HeaderFooterConfig, filename: string): { headerCss: string; footerCss: string } {
  if (!hf.enabled) return { headerCss: '', footerCss: '' }
  const now = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  const cellContent = (text: string): string => {
    if (!text) return '""'
    // Split on our field tokens, mapping page/pages to counters and quoting the
    // literal (escaped) segments. Result is a CSS `content` value list.
    const parts: string[] = []
    const re = /\{\{\s*(page|pages|title|date)\s*\}\}/gi
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const lit = text.slice(last, m.index)
      if (lit) parts.push(`"${cssStr(lit)}"`)
      const tok = m[1].toLowerCase()
      if (tok === 'page') parts.push('counter(page)')
      else if (tok === 'pages') parts.push('counter(pages)')
      else if (tok === 'title') parts.push(`"${cssStr(filename)}"`)
      else if (tok === 'date') parts.push(`"${cssStr(now)}"`)
      last = m.index + m[0].length
    }
    const tail = text.slice(last)
    if (tail) parts.push(`"${cssStr(tail)}"`)
    return parts.length ? parts.join(' ') : '""'
  }
  const band = (band: HeaderFooterBand, region: string): string => {
    const rules: string[] = []
    const map: Record<'left' | 'center' | 'right', string> = { left: `${region}-left`, center: `${region}-center`, right: `${region}-right` }
    for (const cell of ['left', 'center', 'right'] as const) {
      if (band[cell]) rules.push(`@${map[cell]} { content: ${cellContent(band[cell])}; font-family: Georgia, serif; font-size: 10pt; color: #555; }`)
    }
    return rules.join('\n  ')
  }
  return {
    headerCss: `@page {\n  ${band(hf.header, 'top')}\n}`,
    footerCss: `@page {\n  ${band(hf.footer, 'bottom')}\n}`,
  }
}

// Escape a string for safe use inside a CSS double-quoted string literal THAT
// LIVES INSIDE AN INLINE <style> BLOCK. Beyond the CSS string escapes (\ " and
// newline), we must also neutralise `<` and `>`: the HTML tokenizer terminates a
// <style> element at the first literal `</style>` REGARDLESS of CSS quoting, so
// a value like `</style><script>…` would break out of the stylesheet and inject
// live script into the exported file. CSS unicode escapes \3c /\3e render as the
// literal characters in `content:` but can never form an HTML tag.
function cssStr(s: unknown): string {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/</g, '\\3c ')
    .replace(/>/g, '\\3e ')
    .replace(/\n/g, ' ')
}

// Markdown
export function exportToMarkdown(editor: Editor, filename: string): void {
  const html = sanitizeDocHtml(numberFootnotesInHtml(editor.getHTML()))
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
  // GFM table support: turndown drops <table> by default. Add a minimal rule so
  // exported Markdown carries a pipe-table instead of losing the table entirely.
  td.addRule('tables', {
    filter: ['table'],
    replacement: (_content, node) => htmlTableToMarkdown(node),
  })
  const md = td.turndown(html)
  saveAs(new Blob([md], { type: 'text/markdown;charset=utf-8' }), `${filename}.md`)
}

// Convert an HTML <table> DOM node to a GFM pipe-table string. Best-effort:
// flattens each cell to its text, uses the first row as the header, and ignores
// colspan/rowspan (Markdown pipe-tables can't express spans).
function htmlTableToMarkdown(tableNode: HTMLElement): string {
  const rows = Array.from(tableNode.querySelectorAll('tr'))
  if (rows.length === 0) return ''
  const cellText = (cell: Element): string => (cell.textContent || '').replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')
  const toCells = (tr: Element): string[] => Array.from(tr.querySelectorAll('th,td')).map(cellText)
  const header = toCells(rows[0])
  const width = header.length || 1
  const pad = (cells: string[]): string[] => {
    const c = cells.slice(0, width)
    while (c.length < width) c.push('')
    return c
  }
  const lines: string[] = []
  lines.push('| ' + pad(header).join(' | ') + ' |')
  lines.push('| ' + Array(width).fill('---').join(' | ') + ' |')
  for (let i = 1; i < rows.length; i++) {
    lines.push('| ' + pad(toCells(rows[i])).join(' | ') + ' |')
  }
  return '\n\n' + lines.join('\n') + '\n\n'
}

// PDF (browser print)
export function exportToPdf(filename: string): void {
  const old = document.title
  document.title = filename
  window.print()
  document.title = old
}

/** computeFootnoteOrder's Map, carrying the heading outline alongside it (see
 *  exportToDocx below) — avoids threading a second param through every node fn. */
interface FootnoteOrderMap extends Map<string, number> {
  _tocHeadings?: HeadingOutlineEntry[]
}

// DOCX
export async function exportToDocx(editor: Editor, filename: string, opts: ExportOptions = {}): Promise<void> {
  const json = editor.getJSON()
  // Derive the same sequential footnote numbering the editor shows so exported
  // refs/items read 1, 2, 3… (the numbers are decoration-only in the doc JSON).
  const fnOrder: FootnoteOrderMap = computeFootnoteOrder(collectFootnoteRefIds(json))
  // P5: carry the heading outline alongside fnOrder so the tableOfContents node
  // case can render it (avoids threading a second param through every node fn).
  try { fnOrder._tocHeadings = readHeadingsForExport(json) } catch { /* noop */ }
  const children = await nodesToDocx(json.content || [], fnOrder)

  // P3: page size + margins → docx section properties. TWIPs = 1/20 pt = 1/1440 in.
  const setup = normalizePageSetup(opts.pageSetup)
  const size = PAGE_SIZES[setup.size]
  let wIn = size.width, hIn = size.height
  if (setup.orientation === 'landscape') { const t = wIn; wIn = hIn; hIn = t }
  const IN = 1440
  const page = {
    size: {
      width: Math.round(wIn * IN),
      height: Math.round(hIn * IN),
      orientation: setup.orientation,
    },
    margin: {
      top: Math.round(setup.margins.top * IN),
      right: Math.round(setup.margins.right * IN),
      bottom: Math.round(setup.margins.bottom * IN),
      left: Math.round(setup.margins.left * IN),
    },
  }

  // P2: headers & footers → docx Header/Footer with a PageNumber field for
  // {{page}}/{{pages}}. Field tokens resolve to docx PageNumber children so Word
  // fills live page numbers; {{title}}/{{date}} resolve to static text here.
  const hf = normalizeHeaderFooter(opts.headerFooter)
  // Built as a single literal (rather than assigned onto `section` after the
  // fact) because ISectionOptions' headers/footers fields are readonly.
  let headers: ISectionOptions['headers']
  let footers: ISectionOptions['footers']
  if (hf.enabled) {
    const ctx: FieldContext = { title: filename }
    if (bandHasContent(hf.header)) headers = { default: new Header({ children: [bandParagraph(hf.header, ctx)] }) }
    if (bandHasContent(hf.footer)) footers = { default: new Footer({ children: [bandParagraph(hf.footer, ctx)] }) }
  }
  const section: ISectionOptions = { properties: { page }, children, headers, footers }

  const doc = new Document({
    styles: { default: { document: { run: { font: 'Calibri', size: 24 } } } },
    sections: [section],
  })
  const blob = await Packer.toBlob(doc)
  saveAs(blob, `${filename}.docx`)
}

function bandHasContent(band: HeaderFooterBand | null | undefined): boolean {
  return !!(band && (band.left || band.center || band.right))
}

// Build a single tab-separated docx paragraph for a header/footer band. Left is
// flush-left, center centered, right flush-right — approximated with tab stops
// so a three-cell band reads correctly in Word. Field tokens become live docx
// runs ({{page}}/{{pages}} → PageNumber) or resolved text.
function bandParagraph(band: HeaderFooterBand, ctx: FieldContext): Paragraph {
  const runsFor = (text: string) => fieldTextToRuns(text, ctx)
  const children: ParagraphChild[] = []
  // Left cell.
  children.push(...runsFor(band.left))
  children.push(xr({ text: '\t' }))
  // Center cell.
  children.push(...runsFor(band.center))
  children.push(xr({ text: '\t' }))
  // Right cell.
  children.push(...runsFor(band.right))
  return new Paragraph({
    alignment: AlignmentType.LEFT,
    tabStops: [
      { type: 'center', position: 4680 },   // ~mid of a Letter content width
      { type: 'right', position: 9360 },     // ~right edge
    ],
    children,
  })
}

// Convert a header/footer cell string into docx runs, mapping {{page}}/{{pages}}
// to live PageNumber fields and {{title}}/{{date}} to static resolved text.
function fieldTextToRuns(text: string, ctx: FieldContext): TextRun[] {
  if (typeof text !== 'string' || !text) return [xr('')]
  const runs: TextRun[] = []
  const re = /\{\{\s*(page|pages|title|date)\s*\}\}/gi
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const lit = text.slice(last, m.index)
    if (lit) runs.push(xr({ text: lit }))
    const tok = m[1].toLowerCase()
    if (tok === 'page') runs.push(xr({ children: [PageNumber.CURRENT] }))
    else if (tok === 'pages') runs.push(xr({ children: [PageNumber.TOTAL_PAGES] }))
    else runs.push(xr({ text: resolveFields(m[0], ctx) }))
    last = m.index + m[0].length
  }
  const tail = text.slice(last)
  if (tail) runs.push(xr({ text: tail }))
  return runs.length ? runs : [xr('')]
}

async function nodesToDocx(nodes: JSONContent[], fnOrder?: FootnoteOrderMap): Promise<FileChild[]> {
  const out: FileChild[] = []
  for (const node of nodes) {
    out.push(...(await nodeToDocx(node, fnOrder)))
  }
  return out
}

// Recursively flatten nested bullet/ordered lists with indentation levels
async function listToDocx(listNode: JSONContent, depth: number): Promise<FileChild[]> {
  const isOrdered = listNode.type === 'orderedList'
  const items: FileChild[] = []
  for (const item of listNode.content || []) {
    // item is a listItem; its content may be paragraphs and/or nested lists
    for (const child of item.content || []) {
      if (child.type === 'bulletList' || child.type === 'orderedList') {
        items.push(...(await listToDocx(child, depth + 1)))
      } else if (child.type === 'taskItem') {
        const checked = child.attrs?.checked || false
        items.push(new Paragraph({
          bullet: { level: Math.min(depth, 8) },
          children: [xr({ text: (checked ? '☑ ' : '☐ ') }), ...inlineNodes(child.content?.[0]?.content || [])],
        }))
      } else {
        // paragraph or other inline container
        items.push(new Paragraph({
          ...(isOrdered
            ? { numbering: { reference: 'default-numbering', level: Math.min(depth, 8) } }
            : { bullet: { level: Math.min(depth, 8) } }),
          children: inlineNodes(child.content || []),
        }))
      }
    }
  }
  return items
}

const HEADING_MAP: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
}

async function nodeToDocx(node: JSONContent, fnOrder?: FootnoteOrderMap): Promise<FileChild[]> {
  switch (node.type) {
    case 'paragraph':
      return [new Paragraph({ children: inlineNodes(node.content || [], fnOrder) })]
    case 'heading':
      return [new Paragraph({ heading: HEADING_MAP[node.attrs?.level] || HeadingLevel.HEADING_1, children: inlineNodes(node.content || [], fnOrder) })]
    case 'bulletList':
    case 'orderedList':
      return await listToDocx(node, 0)
    case 'taskList':
      return await listToDocx(node, 0)
    case 'blockquote':
      return await nodesToDocx(node.content || [], fnOrder)
    case 'codeBlock':
      return [new Paragraph({ children: [xr({ text: node.content?.map((n) => n.text).join('') || '', font: 'Courier New', size: 20 })] })]
    case 'horizontalRule':
      return [new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'AAAAAA' } } })]
    case 'table': {
      const rows = (node.content || []).map((rowNode) =>
        new TableRow({
          children: (rowNode.content || []).map((cellNode) =>
            new TableCell({
              width: { size: 2000, type: WidthType.DXA },
              children: (cellNode.content || []).map((para) => new Paragraph({ children: inlineNodes(para.content || []) })),
            })
          ),
        })
      )
      return [new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } })]
    }
    case 'image': {
      // WAVE-57: embed only RASTER data: images into the .docx. We reject
      // svg/other data: types (matching the sanitiser) and skip remote https:
      // URLs — docx embeds raw bytes and we can't synchronously fetch a remote
      // image at export time, so a remote <img> is dropped from the DOCX (it
      // still round-trips through HTML export; see DOCX-fidelity note in memory).
      const src: string = node.attrs?.src || ''
      const m = /^data:(image\/(?:png|jpe?g|gif|webp));base64,(.*)$/is.exec(src)
      if (m) {
        try {
          const ext = m[1].split('/')[1].replace('jpg', 'jpeg')
          const buffer = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0))
          // docx needs explicit px dimensions. Derive a width from the node's
          // width attr when it's an absolute px value; otherwise fall back to a
          // sensible default. Aspect isn't known without decoding, so height is
          // proportional to a 4:3 assumption for the default and preserved-ish
          // for px widths — documented as best-effort fidelity.
          const pxWidth = /^(\d+)px$/i.exec(node.attrs?.width || '')
          const width = pxWidth ? Math.min(parseInt(pxWidth[1], 10), 600) : 400
          const height = Math.round(width * 0.75)
          const docxType = ext === 'jpeg' ? 'jpg' : ext
          // NOTE (pre-existing, not fixed here): the data: URI regex above also
          // matches image/webp, but docx's ImageRun only accepts
          // jpg/png/gif/bmp — a webp source produces this cast's value at
          // runtime ("webp"), which is not one of those four and was already
          // an invalid `type` for docx before this file was typed.
          const docxImageType = docxType as 'jpg' | 'png' | 'gif' | 'bmp'
          return [new Paragraph({ children: [new ImageRun({ data: buffer, transformation: { width, height }, type: docxImageType })] })]
        } catch { return [] }
      }
      return []
    }
    case 'tableOfContents': {
      // P5: bake the live outline into the DOCX as a titled list of heading
      // paragraphs (indented by level). Word users can regenerate a field-based
      // ToC; this gives a readable static outline that matches the editor.
      const headings = fnOrder?._tocHeadings || []
      const out: FileChild[] = [new Paragraph({ children: [xr({ text: 'Table of Contents', bold: true })] })]
      for (const h of headings) {
        out.push(new Paragraph({
          indent: { left: (h.level - 1) * 360 },
          children: [xr({ text: h.text || '(untitled heading)' })],
        }))
      }
      return out
    }
    case 'mathBlock': {
      // P4 DOCX (best-effort fidelity): docx has no built-in LaTeX→OMML path and
      // we can't synchronously rasterise KaTeX at export time, so a display
      // equation is exported as its LaTeX source in a monospace, centred
      // paragraph (readable + round-trips as text). Documented as best-effort;
      // the HTML export renders true KaTeX. See DOCX-fidelity note.
      const latex = node.attrs?.latex || ''
      return [new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [xr({ text: latex, font: 'Cambria Math', italics: true })],
      })]
    }
    case 'footnotesList': {
      // Render the footnotes section: a rule, then one numbered paragraph per
      // footnote item (number derived from the ref order in the body).
      const out: FileChild[] = [new Paragraph({ border: { top: { style: BorderStyle.SINGLE, size: 1, color: 'AAAAAA' } } })]
      for (const item of node.content || []) {
        if (item.type !== 'footnoteItem') continue
        const num = fnOrder?.get(item.attrs?.id)
        const marker = num ? `${num}. ` : ''
        // A footnoteItem holds paragraph+ content; flatten them, prefixing the
        // first with its number.
        const paras = item.content || []
        paras.forEach((para, i) => {
          const inline = inlineNodes(para.content || [], fnOrder)
          const children = i === 0
            ? [xr({ text: marker, bold: true }), ...inline]
            : inline
          out.push(new Paragraph({ children }))
        })
      }
      return out
    }
    default:
      return []
  }
}

export function inlineNodes(nodes: JSONContent[], fnOrder?: FootnoteOrderMap): ParagraphChild[] {
  return nodes.map((node): ParagraphChild => {
    if (node.type === 'footnoteRef') {
      const num = fnOrder?.get(node.attrs?.id)
      return xr({ text: num ? String(num) : '*', superScript: true })
    }
    // P4: inline equation → its LaTeX source in Cambria Math (best-effort; see
    // the mathBlock note above and the DOCX-fidelity note).
    if (node.type === 'mathInline') {
      return xr({ text: node.attrs?.latex || '', font: 'Cambria Math', italics: true })
    }
    // SMART CHIPS: a chip has no `text` child — its display text is the `label`
    // attribute. Emit it as a styled run so the chip's content is PRESERVED in
    // the .docx (silent-drop is the worst failure for this product). A file chip
    // becomes its label text (docx has no in-app link target); person/date/place
    // become their label. Coloured to read as a chip.
    if (node.type === 'smartChip') {
      const label: string = (node.attrs?.label || '').slice(0, 200)
      if (!label) return xr('')
      return xr({ text: label, color: '3730A3', bold: true })
    }
    if (node.type !== 'text') return xr('')
    const marks = node.marks || []
    const hasMark = (type: string) => marks.some((m) => m.type === type)
    const markAttr = (type: string, attr: string) => marks.find((m) => m.type === type)?.attrs?.[attr]
    const color = markAttr('color', 'color')?.replace('#', '')
    // Font size / family live on the textStyle mark (see lib/tiptap/fontStyle.js).
    const rawSize = markAttr('textStyle', 'fontSize')
    const sizePt = rawSize ? parseFloat(rawSize) : NaN
    const rawFamily = markAttr('textStyle', 'fontFamily')
    // docx wants a single font name, not a CSS stack — take the first, unquoted.
    const font: string | undefined = rawFamily
      ? String(rawFamily).split(',')[0].trim().replace(/^['"]|['"]$/g, '')
      : undefined
    // DATA-INTEGRITY: a `link` mark carries the hyperlink href. Previously
    // inlineNodes handled no link case, so the anchor TEXT survived to .docx but
    // the URL was silently dropped — a broken-reference data loss, and
    // inconsistent with the HTML/Markdown exports (which keep links). When a run
    // is linked, render it underlined+blue and wrap it in a docx ExternalHyperlink.
    const href = markAttr('link', 'href')
    const linkOk = typeof href === 'string' && /^(https?:|mailto:)/i.test(href.trim())
    const run = xr({
      text: node.text || '',
      bold: hasMark('bold'),
      italics: hasMark('italic'),
      // Linked runs get the conventional underline even if no explicit mark.
      underline: (hasMark('underline') || linkOk) ? {} : undefined,
      strike: hasMark('strike'),
      superScript: hasMark('superscript'),
      subScript: hasMark('subscript'),
      color: color || (linkOk ? '0563C1' : undefined),
      // docx size is in half-points.
      size: Number.isFinite(sizePt) && sizePt > 0 ? Math.round(sizePt * 2) : undefined,
      font,
    })
    // Only emit a hyperlink for safe schemes (http/https/mailto). A javascript:
    // or data: href is dropped to plain text rather than written as a live link.
    if (linkOk) return new ExternalHyperlink({ link: href.trim(), children: [run] })
    return run
  })
}
