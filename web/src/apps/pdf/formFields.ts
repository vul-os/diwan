/**
 * formFields.js — AcroForm (interactive PDF form) field detection + fill helpers.
 *
 * This is the DocuSign/Adobe "fill forms" primitive for the PDF editor. A PDF
 * that carries an AcroForm exposes its interactive fields (text boxes, checkboxes,
 * radio groups, dropdowns) through pdf.js's `page.getAnnotations()` — each with a
 * field name, type, current value, and a rectangle in *PDF user space* (origin
 * bottom-left). To make those fields fillable inside our canvas-overlay editor we
 * must:
 *
 *   1. Recognise which annotations are form widgets (subtype "Widget").
 *   2. Normalise each into a transport-agnostic descriptor {name,type,value,rect…}.
 *   3. Map its PDF-space rect to the on-screen canvas rect (Y is flipped, both
 *      axes scaled by the render viewport), so an editable overlay can sit exactly
 *      on top of the printed field box.
 *
 * These functions are PURE (no pdf.js, no DOM) so the coordinate math and the
 * type mapping are unit-tested in isolation — the risky part of "fill forms" is
 * the geometry, and this isolates it from the 1800-line editor component.
 */

/** Field kinds we surface a fill affordance for. */
export const FIELD_TEXT = 'text'
export const FIELD_CHECKBOX = 'checkbox'
export const FIELD_RADIO = 'radio'
export const FIELD_CHOICE = 'choice' // dropdown / listbox
export const FIELD_SIGNATURE = 'signature'

export type FieldKind =
  | typeof FIELD_TEXT
  | typeof FIELD_CHECKBOX
  | typeof FIELD_RADIO
  | typeof FIELD_CHOICE
  | typeof FIELD_SIGNATURE

/**
 * Minimal shape of a pdf.js annotation as consumed here — a subset of
 * pdfjs-dist's AnnotationData, narrowed to just the fields this module reads.
 */
export interface PdfAnnotation {
  subtype?: string
  fieldType?: string
  pushButton?: boolean
  radioButton?: boolean
  /** pdf.js also sets this on Btn widgets; unused here (checkbox is the Btn default). */
  checkBox?: boolean
  id?: string | number
  fieldName?: string
  fieldValue?: string | string[] | null
  buttonValue?: string | string[] | null
  exportValue?: string
  readOnly?: boolean
  rect?: number[]
  options?: Array<string | { exportValue?: string; displayValue?: string }>
}

/** A normalised, transport-agnostic fillable-field descriptor. */
export interface FormField {
  id: string
  name: string
  kind: FieldKind
  value: string | string[]
  readOnly: boolean
  rect: number[]
  options?: string[]
  onValue?: string
  checked?: boolean
}

/** A screen-space rectangle for an overlay positioned on the canvas. */
export interface ScreenRect {
  left: number
  top: number
  width: number
  height: number
}

/** An overlay annotation seed consumable by the editor's addAnn() pipeline. */
export interface AnnotationSeed {
  id: string
  type: 'text'
  pageIndex: number
  x: number
  y: number
  content: string
  fontSize: number
  fontFamily: string
  color: string
  bold: boolean
  italic: boolean
  underline: boolean
  fieldName: string
  fromForm: true
  checkbox?: boolean
}

/**
 * Map a pdf.js annotation's fieldType/flags to one of our field kinds.
 * pdf.js reports fieldType as 'Tx' (text), 'Btn' (button: checkbox/radio/push),
 * 'Ch' (choice), 'Sig' (signature). Returns null for non-fillable widgets
 * (e.g. push buttons) so callers can skip them.
 */
export function fieldKind(annot: PdfAnnotation | null | undefined): FieldKind | null {
  if (!annot || annot.subtype !== 'Widget') return null
  switch (annot.fieldType) {
    case 'Tx':
      return FIELD_TEXT
    case 'Ch':
      return FIELD_CHOICE
    case 'Sig':
      return FIELD_SIGNATURE
    case 'Btn': {
      // Button family: distinguish push (not fillable) / radio / checkbox.
      // pdf.js sets `pushButton`, `radioButton`, `checkBox` booleans.
      if (annot.pushButton) return null
      if (annot.radioButton) return FIELD_RADIO
      return FIELD_CHECKBOX
    }
    default:
      return null
  }
}

/**
 * Normalise a single pdf.js widget annotation into a fillable field descriptor,
 * or null if it is not a fillable field. The `rect` stays in PDF user space
 * (bottom-left origin) — screen mapping is a separate step so the descriptor is
 * viewport-independent and reusable across zoom levels.
 *
 * Returns a fillable field descriptor, or null if `annot` is not one.
 */
export function toField(annot: PdfAnnotation): FormField | null {
  const kind = fieldKind(annot)
  if (!kind) return null
  const rect = Array.isArray(annot.rect) && annot.rect.length === 4 ? annot.rect : null
  if (!rect) return null
  const field: FormField = {
    id: annot.id != null ? String(annot.id) : (annot.fieldName || Math.random().toString(36).slice(2)),
    name: annot.fieldName || '',
    kind,
    value: annot.fieldValue ?? annot.buttonValue ?? '',
    readOnly: !!annot.readOnly,
    rect: rect.slice(),
  }
  if (kind === FIELD_CHOICE && Array.isArray(annot.options)) {
    // pdf.js options are { exportValue, displayValue }.
    field.options = annot.options.map((o) =>
      typeof o === 'string' ? o : (o.displayValue ?? o.exportValue ?? ''),
    )
  }
  if (kind === FIELD_CHECKBOX || kind === FIELD_RADIO) {
    // The "on" export value (what a checked box stores). Default "Yes".
    field.onValue = annot.exportValue || (Array.isArray(annot.buttonValue) ? annot.buttonValue[0] : annot.buttonValue) || 'Yes'
    field.checked = !!annot.fieldValue && annot.fieldValue !== 'Off'
  }
  return field
}

/**
 * Extract all fillable fields from a page's pdf.js annotation array. Non-widget
 * annotations (links, popups) and non-fillable widgets (push buttons) are dropped.
 */
export function extractFields(annotations: PdfAnnotation[] | null | undefined): FormField[] {
  if (!Array.isArray(annotations)) return []
  const out: FormField[] = []
  for (const a of annotations) {
    const f = toField(a)
    if (f) out.push(f)
  }
  return out
}

/**
 * Map a field's PDF-space rect to the on-screen (canvas) rect for the current
 * render viewport.
 *
 * PDF user space has its origin at the BOTTOM-left with Y increasing upward; the
 * rendered canvas has its origin at the TOP-left with Y increasing downward. The
 * viewport carries the render scale and the page height in PDF units, so:
 *
 *   screenX = x1 * scale
 *   screenY = (pageHeightPdf - y2) * scale      // top edge, Y flipped
 *   width   = (x2 - x1) * scale
 *   height  = (y2 - y1) * scale
 *
 * `rect` is [x1,y1,x2,y2] in PDF units (as pdf.js reports, already normalised so
 * x1<x2, y1<y2). `pageHeightPdf` is the page height in PDF units (unscaled).
 *
 * `rect` is [x1,y1,x2,y2] PDF-space; `pageHeightPdf` is the page height in PDF
 * units (unscaled); `scale` is the render scale (zoom).
 */
export function pdfRectToScreen(rect: number[], pageHeightPdf: number, scale: number): ScreenRect {
  const [x1, y1, x2, y2] = rect
  const left = Math.min(x1, x2) * scale
  const width = Math.abs(x2 - x1) * scale
  const height = Math.abs(y2 - y1) * scale
  // Top edge = distance from the page top to the field's UPPER (larger-Y) edge.
  const topY = Math.max(y1, y2)
  const top = (pageHeightPdf - topY) * scale
  return { left, top, width, height }
}

/**
 * Inverse of pdfRectToScreen for a point drop — map a screen (x,y) on the canvas
 * back to PDF user space. Used when an overlay-filled value must be written back
 * at the field's PDF coordinates on export.
 *
 * Returns the PDF-space point.
 */
export function screenPointToPdf(
  x: number,
  y: number,
  pageHeightPdf: number,
  scale: number,
): { x: number; y: number } {
  return { x: x / scale, y: pageHeightPdf - y / scale }
}

/**
 * Build overlay annotation seeds for the editor from detected form fields on a
 * page. Each fillable text/choice field becomes a pre-positioned, empty (or
 * prefilled) text annotation; checkboxes/radios become toggle annotations. The
 * editor's existing annotation pipeline then renders + exports them, so form-fill
 * reuses the same save path as manual annotations (no separate export path).
 *
 * `fields` is extractFields() output; `pageSlot` is the display page slot
 * these live on; `inkColor` is the annotation ink colour; `genId` is an id
 * generator. Returns annotation objects for addAnn().
 */
export function fieldsToAnnotations(
  fields: FormField[],
  pageSlot: number,
  pageHeightPdf: number,
  scale: number,
  inkColor: string,
  genId?: () => string,
): AnnotationSeed[] {
  const mk = typeof genId === 'function' ? genId : () => Math.random().toString(36).slice(2)
  const seeds: AnnotationSeed[] = []
  for (const f of fields) {
    if (f.readOnly) continue
    const box = pdfRectToScreen(f.rect, pageHeightPdf, scale)
    if (f.kind === FIELD_TEXT || f.kind === FIELD_CHOICE) {
      seeds.push({
        id: mk(),
        type: 'text',
        pageIndex: pageSlot,
        x: box.left + 2,
        y: box.top + 2,
        content: typeof f.value === 'string' ? f.value : '',
        fontSize: Math.max(9, Math.min(16, Math.round(box.height * 0.6))),
        fontFamily: 'Helvetica',
        color: inkColor,
        bold: false,
        italic: false,
        underline: false,
        fieldName: f.name,
        fromForm: true,
      })
    } else if (f.kind === FIELD_CHECKBOX || f.kind === FIELD_RADIO) {
      seeds.push({
        id: mk(),
        type: 'text',
        pageIndex: pageSlot,
        x: box.left + 1,
        y: box.top + 1,
        content: f.checked ? '✓' : '',
        fontSize: Math.max(10, Math.min(18, Math.round(box.height * 0.75))),
        fontFamily: 'Helvetica',
        color: inkColor,
        bold: true,
        italic: false,
        underline: false,
        fieldName: f.name,
        fromForm: true,
        checkbox: true,
      })
    }
  }
  return seeds
}
