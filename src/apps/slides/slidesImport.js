/**
 * slidesImport.js — .pptx / .odp → the positioned-object slide model.
 * ----------------------------------------------------------------------------
 * pptxgenjs (our exporter) is write-only, and there is no light pptx *reader*,
 * so we parse the OOXML / ODF parts ourselves. The win the new positioned-object
 * model buys us: PPTX shapes and ODP frames are natively positioned (EMU / cm
 * offsets + extents), so they map DIRECTLY onto our normalized [0,1] object
 * geometry — we get real text boxes, images, and placement, not just a flat
 * title+body dump.
 *
 * Everything flows through the structural bounds (safeLoadZip / parseXmlSafe —
 * zip-bomb, zip-slip, XXE) here, and every produced object is handed to
 * `sanitizeObjects` (script/CSS/href + geometry clamp) by the caller before it
 * is stored or rendered. Text is XML-escaped as it is lifted out of the parts.
 *
 * FIDELITY IS HONEST-PARTIAL. What lands: slide order, text boxes with their
 * position/size + bold/italic runs, titles, embedded RASTER images with their
 * position/size, and speaker notes (pptx). What is dropped/approximated: theme
 * colours & fonts, gradients, tables, charts, SmartArt, animations, transitions,
 * masters/layouts, grouped-shape geometry, and vector/auto shapes (a native
 * pptx auto-shape becomes a text box if it carries text, else is skipped). This
 * is a best-effort content importer, not a rendering-faithful one.
 */

import {
  safeLoadZip, entryText, entryDataUri, parseXmlSafe, MAX_SLIDES, ImportError,
} from '../../lib/importBounds.js'
import { newObjectId } from './slideObjects'
import { makeSlideImportNotes } from './importNotes'

const EMU_PER_SLIDE_DEFAULT_W = 12192000   // 16:9 wide default (EMU)
const EMU_PER_SLIDE_DEFAULT_H = 6858000

const RASTER_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', emf: null, wmf: null, tiff: null,
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function clamp01ish(n, dflt) {
  return Number.isFinite(n) ? n : dflt
}

// ── PPTX ──────────────────────────────────────────────────────────────────────

// Parse ppt/slides/_rels/slideN.xml.rels → { rId: targetPathRelativeToSlides }.
function parseRels(relsXml) {
  const map = {}
  if (!relsXml) return map
  let doc
  try { doc = parseXmlSafe(relsXml, 'rels') } catch { return map }
  for (const rel of Array.from(doc.getElementsByTagName('Relationship'))) {
    const id = rel.getAttribute('Id')
    const target = rel.getAttribute('Target')
    if (id && target) map[id] = target
  }
  return map
}

// Resolve a slide-relative rels target ("../media/image1.png") to an archive path.
function resolveMediaPath(target) {
  if (typeof target !== 'string') return null
  if (/^[a-z]+:/i.test(target)) return null           // external URL target → never fetch
  const path = ('ppt/slides/' + target).split('/')
  const stack = []
  for (const seg of path) {
    if (seg === '..') stack.pop()
    else if (seg === '.' || seg === '') continue
    else stack.push(seg)
  }
  const resolved = stack.join('/')
  if (resolved.includes('..')) return null
  return resolved
}

// Read text runs from a <p:txBody>, returning HTML paragraphs with bold/italic.
function txBodyToHtml(txBody, asTitle) {
  const paras = []
  for (const p of Array.from(txBody.getElementsByTagName('a:p'))) {
    let line = ''
    for (const r of Array.from(p.getElementsByTagName('a:r'))) {
      const t = r.getElementsByTagName('a:t')[0]
      if (!t) continue
      let text = esc(t.textContent || '')
      const rPr = r.getElementsByTagName('a:rPr')[0]
      if (rPr) {
        if (rPr.getAttribute('b') === '1') text = `<strong>${text}</strong>`
        if (rPr.getAttribute('i') === '1') text = `<em>${text}</em>`
      }
      line += text
    }
    if (line.trim()) paras.push(line)
  }
  if (paras.length === 0) return ''
  if (asTitle) return `<h2>${paras.join(' ')}</h2>`
  if (paras.length === 1) return `<p>${paras[0]}</p>`
  return `<ul>${paras.map((l) => `<li><p>${l}</p></li>`).join('')}</ul>`
}

// Extract a:off/a:ext geometry from an element's descendant a:xfrm, normalized.
function geomFromXfrm(el, slideW, slideH) {
  const xfrm = el.getElementsByTagName('a:xfrm')[0]
  if (!xfrm) return null
  const off = xfrm.getElementsByTagName('a:off')[0]
  const ext = xfrm.getElementsByTagName('a:ext')[0]
  if (!off || !ext) return null
  const x = parseInt(off.getAttribute('x') || '', 10)
  const y = parseInt(off.getAttribute('y') || '', 10)
  const cx = parseInt(ext.getAttribute('cx') || '', 10)
  const cy = parseInt(ext.getAttribute('cy') || '', 10)
  if (![x, y, cx, cy].every(Number.isFinite)) return null
  return {
    x: clamp01ish(x / slideW, 0.1),
    y: clamp01ish(y / slideH, 0.1),
    w: clamp01ish(cx / slideW, 0.3),
    h: clamp01ish(cy / slideH, 0.2),
  }
}

async function pptxSlideToObjects(xmlText, relsXml, zip, slideW, slideH, loss) {
  const doc = parseXmlSafe(xmlText, 'slide')
  const rels = parseRels(relsXml)
  const objects = []
  let z = 1
  const spTree = doc.getElementsByTagName('p:spTree')[0] || doc

  // ── Import-honesty accounting (see importNotes.js) ─────────────────────────
  // Detect the native pptx constructs our positioned-object model CANNOT
  // represent, so the user is told — at import, and again before an export
  // overwrites their original — exactly what did not come in. Counting only;
  // the elements themselves are not imported.
  if (loss) {
    // p:graphicFrame carries tables (a:tbl), charts (graphicData uri …/chart),
    // and SmartArt diagrams (…/diagram) — none of which we can import.
    for (const gf of Array.from(doc.getElementsByTagName('p:graphicFrame'))) {
      if (gf.getElementsByTagName('a:tbl').length) { loss.tables++; continue }
      const gd = gf.getElementsByTagName('a:graphicData')[0]
      const uri = gd?.getAttribute('uri') || ''
      if (/chart/i.test(uri)) loss.charts++
      else if (/diagram/i.test(uri)) loss.diagrams++
      else loss.charts++ // OLE/other embedded object — closest honest bucket
    }
    // Grouped shapes: geometry of the group is not preserved.
    loss.groups += doc.getElementsByTagName('p:grpSp').length
    // Per-slide transition + animation timeline are dropped.
    if (doc.getElementsByTagName('p:transition').length) loss.transitions++
    if (doc.getElementsByTagName('p:timing').length) loss.animations++
  }

  // Text shapes (p:sp).
  for (const sp of Array.from(spTree.getElementsByTagName('p:sp'))) {
    const txBody = sp.getElementsByTagName('p:txBody')[0]
    if (!txBody) continue
    const ph = sp.getElementsByTagName('p:ph')[0]
    const phType = ph?.getAttribute('type') || ''
    const isTitle = phType === 'title' || phType === 'ctrTitle'
    const html = txBodyToHtml(txBody, isTitle)
    if (!html) continue
    const g = geomFromXfrm(sp, slideW, slideH) || (isTitle
      ? { x: 0.08, y: 0.08, w: 0.84, h: 0.18 }
      : { x: 0.08, y: 0.3, w: 0.84, h: 0.5 })
    objects.push({ id: newObjectId(), type: 'text', ...g, rotation: 0, z: z++, html, align: 'left', valign: 'top' })
  }

  // Pictures (p:pic).
  for (const pic of Array.from(spTree.getElementsByTagName('p:pic'))) {
    const blip = pic.getElementsByTagName('a:blip')[0]
    const embed = blip?.getAttribute('r:embed')
    if (!embed) continue
    const target = rels[embed]
    const path = resolveMediaPath(target)
    if (!path) continue
    const ext = (path.split('.').pop() || '').toLowerCase()
    const mime = RASTER_MIME[ext]
    if (!mime) { if (loss) loss.vectorImages++; continue } // emf/wmf/tiff/other non-raster — can't embed
    if (!zip.files[path]) continue
    let src = ''
    try { src = await entryDataUri(zip, path, mime) } catch { continue }
    const g = geomFromXfrm(pic, slideW, slideH) || { x: 0.25, y: 0.2, w: 0.5, h: 0.5 }
    objects.push({ id: newObjectId(), type: 'image', ...g, rotation: 0, z: z++, src })
  }

  return objects
}

async function readSlideSize(zip) {
  try {
    const presXml = await entryText(zip, 'ppt/presentation.xml')
    if (presXml) {
      const doc = parseXmlSafe(presXml, 'presentation')
      const sz = doc.getElementsByTagName('p:sldSz')[0]
      const cx = parseInt(sz?.getAttribute('cx') || '', 10)
      const cy = parseInt(sz?.getAttribute('cy') || '', 10)
      if (Number.isFinite(cx) && Number.isFinite(cy) && cx > 0 && cy > 0) return { w: cx, h: cy }
    }
  } catch { /* fall through to default */ }
  return { w: EMU_PER_SLIDE_DEFAULT_W, h: EMU_PER_SLIDE_DEFAULT_H }
}

async function readNotes(zip, slideNum) {
  const notePath = `ppt/notesSlides/notesSlide${slideNum}.xml`
  if (!zip.files[notePath]) return ''
  try {
    const xml = await entryText(zip, notePath)
    const doc = parseXmlSafe(xml, 'notes')
    const texts = Array.from(doc.getElementsByTagName('a:t')).map((t) => t.textContent || '')
    return texts.join(' ').trim().slice(0, 5000)
  } catch { return '' }
}

export async function pptxToSlides(arrayBuffer, filename = 'file.pptx') {
  const zip = await safeLoadZip(arrayBuffer, filename)
  const { w: slideW, h: slideH } = await readSlideSize(zip)

  const slideEntries = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => parseInt(a.match(/slide(\d+)/)[1], 10) - parseInt(b.match(/slide(\d+)/)[1], 10))
    .slice(0, MAX_SLIDES)

  // Aggregate import losses across all slides (see importNotes.js).
  const loss = { tables: 0, charts: 0, diagrams: 0, groups: 0, vectorImages: 0, animations: 0, transitions: 0 }

  const slides = []
  for (const entry of slideEntries) {
    const num = parseInt(entry.match(/slide(\d+)/)[1], 10)
    const xmlText = await entryText(zip, entry)
    const relsXml = await entryText(zip, `ppt/slides/_rels/slide${num}.xml.rels`)
    const objects = await pptxSlideToObjects(xmlText, relsXml, zip, slideW, slideH, loss)
    const notes = await readNotes(zip, num)
    slides.push({
      id: newObjectId(), title: '', content: '<p></p>', notes,
      background: '', master: 'content', transition: 'none', animations: [], objects,
    })
  }

  if (slides.length === 0) {
    slides.push({
      id: newObjectId(), title: '', content: '<p></p>', notes: '',
      background: '', master: 'content', transition: 'none', animations: [], objects: [],
    })
  }
  const deck = { themeId: 'obsidian', theme: 'black', transition: 'slide', slides, masters: null, customTheme: null }
  const importNotes = makeSlideImportNotes({ ...loss, filename })
  if (importNotes) deck.importNotes = importNotes
  return deck
}

// ── ODP ──────────────────────────────────────────────────────────────────────
// ODF measurements are lengths like "12.7cm" / "5in" / "360pt". Convert to a
// fraction of the page using the page geometry from the master-page/page-layout,
// defaulting to the common 25.4cm × 19.05cm (10in × 7.5in) 4:3 page.

function odfLenToInches(v) {
  if (typeof v !== 'string') return NaN
  const m = /^(-?[\d.]+)\s*(cm|mm|in|pt|pc|px)?$/i.exec(v.trim())
  if (!m) return NaN
  const n = parseFloat(m[1])
  if (!Number.isFinite(n)) return NaN
  switch ((m[2] || 'in').toLowerCase()) {
    case 'cm': return n / 2.54
    case 'mm': return n / 25.4
    case 'in': return n
    case 'pt': return n / 72
    case 'pc': return n / 6
    case 'px': return n / 96
    default: return n
  }
}

async function odpFrameToObject(frame, pageWIn, pageHIn, zip, z) {
  const xIn = odfLenToInches(frame.getAttribute('svg:x'))
  const yIn = odfLenToInches(frame.getAttribute('svg:y'))
  const wIn = odfLenToInches(frame.getAttribute('svg:width'))
  const hIn = odfLenToInches(frame.getAttribute('svg:height'))
  const g = {
    x: clamp01ish(xIn / pageWIn, 0.1),
    y: clamp01ish(yIn / pageHIn, 0.1),
    w: clamp01ish(wIn / pageWIn, 0.3),
    h: clamp01ish(hIn / pageHIn, 0.2),
  }

  const image = frame.getElementsByTagName('draw:image')[0]
  if (image) {
    const href = image.getAttribute('xlink:href')
    if (typeof href === 'string' && href && !/^[a-z]+:/i.test(href) && !href.includes('..')) {
      const path = href.replace(/^\.?\//, '')
      const ext = (path.split('.').pop() || '').toLowerCase()
      const mime = RASTER_MIME[ext]
      if (mime && zip.files[path]) {
        try {
          const src = await entryDataUri(zip, path, mime)
          return { id: newObjectId(), type: 'image', ...g, rotation: 0, z, src }
        } catch { /* fall through */ }
      }
    }
    return null
  }

  const textBox = frame.getElementsByTagName('draw:text-box')[0]
  if (textBox) {
    const paras = []
    for (const node of Array.from(textBox.childNodes)) {
      if (node.nodeType !== 1) continue
      if (node.localName === 'h' || node.localName === 'p') {
        const text = esc((node.textContent || '').trim())
        if (text) paras.push({ tag: node.localName, text })
      }
    }
    if (paras.length === 0) return null
    let html
    if (paras.length === 1) {
      const p = paras[0]
      html = p.tag === 'h' ? `<h2>${p.text}</h2>` : `<p>${p.text}</p>`
    } else {
      html = `<ul>${paras.map((p) => `<li><p>${p.text}</p></li>`).join('')}</ul>`
    }
    return { id: newObjectId(), type: 'text', ...g, rotation: 0, z, html, align: 'left', valign: 'top' }
  }
  return null
}

export async function odpToSlides(arrayBuffer, filename = 'file.odp') {
  const zip = await safeLoadZip(arrayBuffer, filename)
  const contentXml = await entryText(zip, 'content.xml')
  if (!contentXml) throw new ImportError(`${filename} is not a valid ODP (no content.xml).`)
  const doc = parseXmlSafe(contentXml, 'ODP content')

  // Page geometry: read the first page-layout's page dimensions if present.
  let pageWIn = 10, pageHIn = 7.5
  const pl = doc.getElementsByTagName('style:page-layout-properties')[0]
  if (pl) {
    const w = odfLenToInches(pl.getAttribute('fo:page-width'))
    const h = odfLenToInches(pl.getAttribute('fo:page-height'))
    if (Number.isFinite(w) && w > 0) pageWIn = w
    if (Number.isFinite(h) && h > 0) pageHIn = h
  }

  const pages = Array.from(doc.getElementsByTagName('draw:page')).slice(0, MAX_SLIDES)
  const slides = []
  for (const page of pages) {
    const objects = []
    let z = 1
    for (const frame of Array.from(page.getElementsByTagName('draw:frame'))) {
      const obj = await odpFrameToObject(frame, pageWIn, pageHIn, zip, z)
      if (obj) { objects.push(obj); z++ }
    }
    slides.push({
      id: newObjectId(), title: '', content: '<p></p>', notes: '',
      background: '', master: 'content', transition: 'none', animations: [], objects,
    })
  }

  if (slides.length === 0) {
    slides.push({
      id: newObjectId(), title: '', content: '<p></p>', notes: '',
      background: '', master: 'content', transition: 'none', animations: [], objects: [],
    })
  }
  return { themeId: 'obsidian', theme: 'black', transition: 'slide', slides, masters: null, customTheme: null }
}
