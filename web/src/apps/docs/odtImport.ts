/**
 * odtImport.js — best-effort OpenDocument Text (.odt) → semantic HTML.
 * ----------------------------------------------------------------------------
 * There is no lightweight, maintained odt→html npm library, so rather than pull
 * in a heavy office-suite dependency we parse the ODF `content.xml` ourselves:
 * unzip (bounded, zip-slip-checked), XXE-safe DOMParser, then walk the ODF text
 * tree into the SAME semantic HTML subset mammoth emits for .docx — headings,
 * paragraphs, bold/italic/underline runs, ordered/unordered lists, tables,
 * links, and embedded raster images (extracted from the zip's Pictures/ folder
 * as bounded base64 data: URIs — NEVER fetched from the network).
 *
 * The HTML this returns is UNTRUSTED and is handed back to the caller as `_html`,
 * which DocsEditor runs through `sanitizeDocHtml` before it reaches TipTap. So
 * this module only needs to produce structure; the script/CSS/href trust
 * boundary is enforced downstream (and the `hrefSafe`/text escaping here is
 * defence-in-depth). FIDELITY IS HONEST-PARTIAL: character/paragraph styles
 * beyond bold/italic/underline (colour, font, size, precise spacing, columns,
 * footnotes, change-tracking, embedded objects) are dropped — the goal is
 * readable, editable content, not pixel-perfect layout.
 */

import { safeLoadZip, entryText, entryDataUri, parseXmlSafe, MAX_HTML_BYTES, ImportError } from '../../lib/importBounds.js'

const RASTER_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp',
}

interface RunStyle {
  bold: boolean
  italic: boolean
  underline: boolean
}

function escapeText(s: unknown): string {
  const str = typeof s === 'string' || typeof s === 'number' || typeof s === 'boolean' ? String(s) : ''
  return str
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Only http(s)/mailto/relative anchors survive as links (defence-in-depth; the
// downstream sanitiser also gates href). javascript:/data: etc. become plain
// text (we drop the <a> wrapper).
function hrefSafe(href: unknown): string | null {
  if (typeof href !== 'string') return null
  const s = href.trim()
  if (!s) return null
  if (/^(?:https?:|mailto:)/i.test(s)) return s
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null   // any other explicit scheme → drop
  return s   // relative / fragment
}

// Build a lookup of automatic style-name → { bold, italic, underline } from the
// <office:automatic-styles> and <office:styles> blocks. ODF puts run formatting
// in style:text-properties (fo:font-weight / fo:font-style / style:text-underline-*).
function buildStyleMap(doc: Document): Map<string, RunStyle> {
  const map = new Map<string, RunStyle>()
  const styles = doc.getElementsByTagName('style:style')
  for (const st of Array.from(styles)) {
    const name = st.getAttribute('style:name')
    if (!name) continue
    const tp = st.getElementsByTagName('style:text-properties')[0]
    if (!tp) continue
    const weight = tp.getAttribute('fo:font-weight') || ''
    const fstyle = tp.getAttribute('fo:font-style') || ''
    const underline = tp.getAttribute('style:text-underline-style') || ''
    map.set(name, {
      bold: /bold|[6-9]00/.test(weight),
      italic: /italic|oblique/.test(fstyle),
      underline: !!underline && underline !== 'none',
    })
  }
  return map
}

export async function odtToHtml(arrayBuffer: ArrayBuffer | Uint8Array, filename = 'file.odt'): Promise<string> {
  const zip = await safeLoadZip(arrayBuffer, filename)
  const contentXml = await entryText(zip, 'content.xml')
  if (!contentXml) throw new ImportError(`${filename} is not a valid ODT (no content.xml).`)
  const doc = parseXmlSafe(contentXml, 'ODT content')
  const styleMap = buildStyleMap(doc)

  // Resolve a Pictures/ image href → bounded raster data: URI (or null).
  async function imageDataUri(href: unknown): Promise<string | null> {
    if (typeof href !== 'string' || !href) return null
    // ODF hrefs are archive-relative, often "Pictures/xxxx.png". Strip a leading
    // "./" and reject anything that isn't a plain in-archive path.
    const path = href.replace(/^\.?\//, '')
    if (path.includes('..') || /^[a-z]+:/i.test(path)) return null   // no traversal / external
    const ext = (path.split('.').pop() || '').toLowerCase()
    const mime = RASTER_MIME[ext]
    if (!mime) return null                       // only raster images are embedded
    if (!zip.files[path]) return null
    try { return await entryDataUri(zip, path, mime) } catch { return null }
  }

  // The office text body.
  const body = doc.getElementsByTagName('office:text')[0]
  if (!body) return '<p></p>'

  const out: string[] = []
  let budget = MAX_HTML_BYTES
  const push = (s: string) => {
    budget -= s.length
    if (budget < 0) throw new ImportError(`${filename} produced too much content to import.`)
    out.push(s)
  }

  // Inline serialiser: walk a text-container's children, honouring text:span
  // formatting, text:a links, line breaks, tabs, and inline images.
  async function inline(node: Node): Promise<string> {
    let html = ''
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {           // text node
        html += escapeText(child.nodeValue)
        continue
      }
      if (child.nodeType !== 1) continue
      const el = child as Element
      const ln = el.localName
      if (ln === 'span') {
        const styleName = el.getAttribute('text:style-name') || ''
        const fmt = styleMap.get(styleName) || ({} as Partial<RunStyle>)
        let inner = await inline(el)
        if (fmt.bold) inner = `<strong>${inner}</strong>`
        if (fmt.italic) inner = `<em>${inner}</em>`
        if (fmt.underline) inner = `<u>${inner}</u>`
        html += inner
      } else if (ln === 'a') {
        const href = hrefSafe(el.getAttribute('xlink:href'))
        const inner = await inline(el)
        html += href ? `<a href="${escapeText(href)}">${inner}</a>` : inner
      } else if (ln === 'line-break') {
        html += '<br>'
      } else if (ln === 'tab') {
        html += ' '
      } else if (ln === 's') {                 // <text:s text:c="n"> = n spaces
        const c = parseInt(el.getAttribute('text:c') || '1', 10)
        html += ' '.repeat(Math.min(Number.isFinite(c) ? c : 1, 64))
      } else if (ln === 'frame' || ln === 'image') {
        html += await imageFromFrame(el)
      } else if (ln) {
        html += await inline(el)            // unknown inline wrapper → flatten
      }
    }
    return html
  }

  // A draw:frame usually wraps a draw:image (and optionally a svg:desc). Extract
  // the first raster image; drop OLE objects / applets / plugins entirely.
  async function imageFromFrame(frame: Element): Promise<string> {
    const img = frame.localName === 'image'
      ? frame
      : frame.getElementsByTagName('draw:image')[0]
    if (!img) return ''
    const href = img.getAttribute('xlink:href')
    const uri = await imageDataUri(href)
    return uri ? `<img src="${escapeText(uri)}" alt="">` : ''
  }

  async function block(node: Element): Promise<void> {
    const ln = node.localName
    if (ln === 'h') {
      const lvlRaw = parseInt(node.getAttribute('text:outline-level') || '1', 10)
      const lvl = Math.min(Math.max(Number.isFinite(lvlRaw) ? lvlRaw : 1, 1), 6)
      const inner = await inline(node)
      push(`<h${lvl}>${inner || ''}</h${lvl}>`)
    } else if (ln === 'p') {
      const inner = await inline(node)
      push(`<p>${inner || ''}</p>`)
    } else if (ln === 'list') {
      push(await listHtml(node))
    } else if (ln === 'table') {
      push(await tableHtml(node))
    } else if (ln) {
      // Section / frame / other container → recurse into its blocks.
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 1) await block(child as Element)
      }
    }
  }

  async function listHtml(listNode: Element, ordered = false): Promise<string> {
    // ODF doesn't tag ordered vs bullet on the list element itself (it's on the
    // referenced list-style); best-effort: honour a style hint if present, else
    // default to unordered. Nested lists recurse.
    const items: string[] = []
    for (const item of Array.from(listNode.childNodes)) {
      if (item.nodeType !== 1 || (item as Element).localName !== 'list-item') continue
      let inner = ''
      for (const c of Array.from(item.childNodes)) {
        if (c.nodeType !== 1) continue
        const cEl = c as Element
        if (cEl.localName === 'list') inner += await listHtml(cEl, ordered)
        else if (cEl.localName === 'h' || cEl.localName === 'p') inner += `<p>${await inline(cEl)}</p>`
      }
      items.push(`<li>${inner}</li>`)
    }
    const tag = ordered ? 'ol' : 'ul'
    return `<${tag}>${items.join('')}</${tag}>`
  }

  async function tableHtml(tableNode: Element): Promise<string> {
    const rows: string[] = []
    for (const row of Array.from(tableNode.getElementsByTagName('table:table-row'))) {
      const cells: string[] = []
      for (const cell of Array.from(row.childNodes)) {
        if (cell.nodeType !== 1 || (cell as Element).localName !== 'table-cell') continue
        let inner = ''
        for (const c of Array.from(cell.childNodes)) {
          if (c.nodeType === 1) inner += await inline(c)
        }
        const span = parseInt((cell as Element).getAttribute('table:number-columns-spanned') || '1', 10)
        const colspan = span > 1 ? ` colspan="${Math.min(span, 100)}"` : ''
        cells.push(`<td${colspan}>${inner}</td>`)
      }
      rows.push(`<tr>${cells.join('')}</tr>`)
    }
    return `<table><tbody>${rows.join('')}</tbody></table>`
  }

  for (const node of Array.from(body.childNodes)) {
    if (node.nodeType === 1) await block(node as Element)
  }
  const html = out.join('\n')
  return html || '<p></p>'
}
