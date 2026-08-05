import { saveAs } from 'file-saver'
import pptxgen from 'pptxgenjs'
import { stripHtml } from '../../lib/sanitize'
import { stripXmlInvalidChars } from '../../lib/xmlText.js'
import { ensureObjects, type SlideObject } from './slideObjects'

type PptxSlide = pptxgen.Slide
type PptxShapeName = pptxgen.SHAPE_NAME
type PptxImageProps = pptxgen.ImageProps
type PptxShapeProps = pptxgen.ShapeProps
type PptxTextPropsOptions = pptxgen.TextPropsOptions

interface ThemeColors {
  bg: string
  fg: string
}

interface ExportSlide {
  title?: string
  content?: string
  notes?: string
  background?: string
  objects?: unknown[]
  [key: string]: unknown
}

interface ExportDeck {
  theme?: string
  slides: ExportSlide[]
}

export function exportSlidesToPdf(filename: string): void {
  const old = document.title
  document.title = filename
  window.print()
  document.title = old
}

// LAYOUT_WIDE is 13.333in × 7.5in.
const SLIDE_W = 13.333
const SLIDE_H = 7.5

const THEME_COLORS: Record<string, ThemeColors> = {
  black: { bg: '1a1a2e', fg: 'ffffff' },
  night: { bg: '282c34', fg: 'eeeeee' },
  dracula: { bg: '282a36', fg: 'f8f8f2' },
  white: { bg: 'ffffff', fg: '000000' },
  beige: { bg: 'f7f3de', fg: '333333' },
  sky: { bg: '87ceeb', fg: '333377' },
  solarized: { bg: 'fdf6e3', fg: '657b83' },
  serif: { bg: 'f0ece4', fg: '444444' },
  moon: { bg: '002b36', fg: 'aaaaaa' },
  league: { bg: '1c1e20', fg: 'eeeeee' },
}

// pptxgenjs shape name for each of our shape kinds.
const PPTX_SHAPE: Record<string, PptxShapeName> = {
  rect: 'rect', roundRect: 'roundRect', oval: 'ellipse', triangle: 'triangle',
  star: 'star5', line: 'line', arrow: 'rightArrow', callout: 'wedgeRectCallout',
}

const hex = (c: unknown, dflt: string): string => {
  if (typeof c !== 'string') return dflt
  const m = c.replace('#', '')
  return /^[0-9a-fA-F]{6}$/.test(m) ? m : dflt
}

/**
 * addObjectToSlide — place ONE positioned object onto a pptx slide using its
 * normalized geometry (this is the fidelity gain: PPTX is natively positioned,
 * so object x/y/w/h/rotation map directly to inches + degrees).
 */
function addObjectToSlide(s: PptxSlide, obj: SlideObject, theme: ThemeColors): void {
  const x = obj.x * SLIDE_W
  const y = obj.y * SLIDE_H
  const w = obj.w * SLIDE_W
  const h = obj.h * SLIDE_H
  const rotate = obj.rotation || 0

  if (obj.type === 'text') {
    // strip XML-1.0-illegal control chars: pptxgenjs does NOT, so a VT/FF/NUL in
    // the text would make PowerPoint reject the deck (corrupt slide1.xml).
    const text = stripXmlInvalidChars(stripHtml(obj.html || ''))
    if (!text.trim()) return
    // Rough heading detection: an <h1/h2/h3> wrapper → larger + bold.
    const isHeading = /<h[1-3][\s>]/i.test(obj.html || '')
    const textOpts: PptxTextPropsOptions = {
      x, y, w, h, rotate,
      fontSize: isHeading ? 32 : 18,
      bold: isHeading,
      color: theme.fg,
      fontFace: 'Calibri',
      align: obj.align || 'left',
      valign: obj.valign === 'middle' ? 'middle' : obj.valign === 'bottom' ? 'bottom' : 'top',
      wrap: true,
    }
    s.addText(text, textOpts)
  } else if (obj.type === 'image') {
    // data: URIs and http(s) both work with pptxgenjs `data`/`path`.
    const opt: PptxImageProps = { x, y, w, h, rotate }
    if (/^data:/i.test(obj.src)) opt.data = obj.src
    else opt.path = obj.src
    try { s.addImage(opt) } catch { /* skip an image pptxgenjs rejects */ }
  } else if (obj.type === 'shape') {
    const name = PPTX_SHAPE[obj.shape] || 'rect'
    const shapeOpts: PptxShapeProps = {
      x, y, w, h, rotate,
      line: { color: hex(obj.stroke, '5b4dd0'), width: obj.strokeWidth ?? 2 },
    }
    if (obj.shape !== 'line') {
      shapeOpts.fill = { color: hex(obj.fill, '7c6af7'), transparency: Math.round((1 - (obj.opacity ?? 1)) * 100) }
    }
    s.addShape(name, shapeOpts)
  }
}

export async function exportSlidesToPptx(data: ExportDeck, filename: string): Promise<void> {
  const pres = new pptxgen()
  pres.layout = 'LAYOUT_WIDE'
  const theme = THEME_COLORS[data.theme ?? ''] || THEME_COLORS.black

  for (const slide of data.slides) {
    const s = pres.addSlide()
    s.background = { color: (slide.background?.replace('#', '') || theme.bg) }

    // Positioned-object path (P2): export each object with its real geometry.
    const objects = ensureObjects(slide)
    for (const obj of objects) {
      addObjectToSlide(s, obj, theme)
    }

    // Fallback for a truly empty slide with only a legacy title (ensureObjects
    // already migrates title/content into text objects, so this rarely fires).
    if (objects.length === 0 && slide.title) {
      s.addText(stripXmlInvalidChars(slide.title), { x: 0.5, y: 0.5, w: '90%', h: 1, fontSize: 36, bold: true, color: theme.fg, fontFace: 'Calibri' })
    }

    if (slide.notes) s.addNotes(stripXmlInvalidChars(slide.notes))
  }

  // pptxgenjs's stream() is typed for all its output targets; in a browser it
  // resolves to a Blob (or string), which is what saveAs expects.
  const blob = await pres.stream() as Blob | string
  saveAs(blob, `${filename}.pptx`)
}
