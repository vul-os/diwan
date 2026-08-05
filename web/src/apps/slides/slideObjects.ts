/**
 * slideObjects.js — the positioned-object model for Vulos Slides.
 *
 * ── Coordinate space ────────────────────────────────────────────────────────
 * Every object lives in a **normalized slide-relative space**: x, y, w, h are
 * fractions in [0, 1] of the slide stage (0,0 = top-left, 1,1 = bottom-right).
 * This keeps the model resolution-independent — the same descriptor renders
 * identically at a 320px thumbnail, a 900px editor stage, or a full-screen
 * present view, and maps cleanly onto PPTX's inches (multiply by slide W/H).
 * `rotation` is degrees clockwise. `z` is a stacking integer (higher = front).
 *
 * ── Object shape ────────────────────────────────────────────────────────────
 *   { id, type, x, y, w, h, rotation, z, group?, ...content }
 *   type 'text'  → { html }                 (untrusted → React-escaped/sanitized)
 *   type 'image' → { src }                  (gated by isSafeImageSrc)
 *   type 'shape' → { shape, fill, stroke, strokeWidth, opacity }
 *
 * ── Migration ───────────────────────────────────────────────────────────────
 * Legacy decks store a slide as { title, content(HTML), ... } with no objects[].
 * `ensureObjects(slide)` lazily derives an objects[] from title + content so old
 * decks render on the canvas without a data migration write. Objects are the
 * source of truth once present; `content`/`title` are kept for back-compat
 * export/thumbnail paths and legacy readers.
 *
 * ── CRDT safety (mirrors wave-55/56 ingress discipline) ─────────────────────
 * Objects sync as structured data inside the slide-tree node value. A peer can
 * send anything, so `sanitizeObjects()` validates/clamps EVERY descriptor at the
 * ingress boundary and FAILS CLOSED: non-finite geometry is clamped to a safe
 * box, counts are bounded, unknown types dropped, text HTML sanitized, image
 * src gated. A malformed object is repaired or discarded — never rendered raw,
 * never allowed to throw.
 */

import { sanitizeSlideHtml, isSafeImageSrc } from '../../lib/sanitize'

// Bounds — belt-and-braces against a hostile/corrupt peer op.
export const MAX_OBJECTS_PER_SLIDE = 500
export const MIN_OBJECT_SIZE = 0.01   // 1% of the stage — keeps handles grabbable
export const MAX_Z = 100000

export const OBJECT_TYPES = ['text', 'image', 'shape'] as const
export const SHAPE_KINDS = [
  'rect', 'roundRect', 'oval', 'triangle', 'star', 'line', 'arrow', 'callout',
] as const

export type ObjectType = (typeof OBJECT_TYPES)[number]
export type ShapeKind = (typeof SHAPE_KINDS)[number]
export type TextAlign = 'left' | 'center' | 'right'
export type TextValign = 'top' | 'middle' | 'bottom'

interface BaseSlideObject {
  id: string
  x: number
  y: number
  w: number
  h: number
  rotation: number
  z: number
  group?: string
}

export interface TextSlideObject extends BaseSlideObject {
  type: 'text'
  html: string
  align?: TextAlign
  valign?: TextValign
}

export interface ImageSlideObject extends BaseSlideObject {
  type: 'image'
  src: string
}

export interface ShapeSlideObject extends BaseSlideObject {
  type: 'shape'
  shape: ShapeKind
  fill: string
  stroke: string
  strokeWidth: number
  opacity: number
}

/** A positioned slide object — the union of the three renderable kinds. */
export type SlideObject = TextSlideObject | ImageSlideObject | ShapeSlideObject

/** The slide shape this module reads/migrates — a subset of the full deck slide. */
export interface SlideLike {
  objects?: unknown[]
  title?: string
  content?: string
  [key: string]: unknown
}

/** Clamp a value to a finite number in [lo, hi], falling back to `dflt`. */
export function clampFinite(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return dflt
  if (n < lo) return lo
  if (n > hi) return hi
  return n
}

let _idCounter = 0
export function newObjectId(): string {
  // crypto.randomUUID is available in the browser + jsdom; guard for exotic envs.
  try { return crypto.randomUUID() } catch { /* fall through */ }
  _idCounter += 1
  return `obj-${Date.now()}-${_idCounter}`
}

/** Default geometry helpers (normalized). */
const DEFAULT_TEXT = { x: 0.08, y: 0.30, w: 0.84, h: 0.40 }
const DEFAULT_TITLE = { x: 0.08, y: 0.10, w: 0.84, h: 0.18 }

/**
 * sanitizeObject — validate + clamp a single descriptor at CRDT/JSON ingress.
 * Returns a repaired object, or null if it cannot be salvaged (dropped).
 * FAIL CLOSED by construction: never throws, never returns raw untrusted values.
 */
export function sanitizeObject(raw: unknown): SlideObject | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const type = (OBJECT_TYPES as readonly string[]).includes(r.type as string)
    ? (r.type as ObjectType)
    : null
  if (!type) return null

  const id = typeof r.id === 'string' && r.id ? r.id : newObjectId()

  // Geometry — always finite, on-stage-ish, and non-degenerate.
  const w = clampFinite(r.w, MIN_OBJECT_SIZE, 4, 0.3)
  const h = clampFinite(r.h, MIN_OBJECT_SIZE, 4, 0.2)
  const x = clampFinite(r.x, -2, 3, 0.1)
  const y = clampFinite(r.y, -2, 3, 0.1)
  const rotation = clampFinite(r.rotation, -360, 360, 0)
  const z = Math.round(clampFinite(r.z, -MAX_Z, MAX_Z, 0))

  const base: BaseSlideObject = { id, x, y, w, h, rotation, z }

  // Optional group id (string only).
  if (typeof r.group === 'string' && r.group) base.group = r.group

  if (type === 'text') {
    // Untrusted HTML → shared slide sanitizer (strips script/on*/iframe/…).
    const obj: TextSlideObject = {
      ...base,
      type: 'text',
      html: sanitizeSlideHtml(typeof r.html === 'string' ? r.html : ''),
    }
    if (typeof r.align === 'string' && ['left', 'center', 'right'].includes(r.align)) {
      obj.align = r.align as TextAlign
    }
    if (typeof r.valign === 'string' && ['top', 'middle', 'bottom'].includes(r.valign)) {
      obj.valign = r.valign as TextValign
    }
    return obj
  } else if (type === 'image') {
    // Gate src exactly like DocImage ingress — raster data: or http(s)/relative.
    const src = isSafeImageSrc(r.src) ? (r.src as string) : ''
    if (!src) return null   // an image with no safe src is nothing to render
    return { ...base, type: 'image', src }
  } else {
    // type === 'shape'
    const shape = (SHAPE_KINDS as readonly string[]).includes(r.shape as string)
      ? (r.shape as ShapeKind)
      : 'rect'
    return {
      ...base,
      type: 'shape',
      shape,
      fill: sanitizeColor(r.fill, '#7c6af7'),
      stroke: sanitizeColor(r.stroke, '#5b4dd0'),
      strokeWidth: clampFinite(r.strokeWidth, 0, 40, 2),
      opacity: clampFinite(r.opacity, 0, 1, 1),
    }
  }
}

// Colour: only #hex or a small keyword set / rgb()/rgba() — nothing that can
// carry a url()/expression() fetch or exec construct. Fail closed to `dflt`.
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const RGB_COLOR = /^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*[\d.]+\s*)?\)$/i
const NAMED = new Set([
  'transparent', 'none', 'black', 'white', 'red', 'green', 'blue', 'yellow',
  'orange', 'purple', 'gray', 'grey', 'pink', 'cyan', 'magenta',
])
export function sanitizeColor(v: unknown, dflt: string): string {
  if (typeof v !== 'string') return dflt
  const s = v.trim().toLowerCase()
  if (HEX_COLOR.test(s) || RGB_COLOR.test(s) || NAMED.has(s)) return s
  return dflt
}

/**
 * sanitizeObjects — validate a whole objects[] array at ingress.
 * Drops non-salvageable entries, bounds the count, and re-stacks z so the
 * result is always a clean, finite, render-safe list.
 */
export function sanitizeObjects(arr: unknown): SlideObject[] {
  if (!Array.isArray(arr)) return []
  const out: SlideObject[] = []
  for (const raw of arr) {
    if (out.length >= MAX_OBJECTS_PER_SLIDE) break
    const obj = sanitizeObject(raw)
    if (obj) out.push(obj)
  }
  return out
}

/**
 * ensureObjects — return the slide's objects[], migrating legacy flow content
 * (title + content HTML) into positioned text objects the first time. Pure: it
 * never mutates the input slide; callers persist the derived objects on first
 * edit. Always returns a sanitized array.
 */
export function ensureObjects(slide: SlideLike | null | undefined): SlideObject[] {
  if (!slide || typeof slide !== 'object') return []
  if (Array.isArray(slide.objects)) return sanitizeObjects(slide.objects)

  const objs: TextSlideObject[] = []
  let z = 1
  if (slide.title && String(slide.title).trim()) {
    objs.push({
      id: newObjectId(), type: 'text', ...DEFAULT_TITLE, rotation: 0, z: z++,
      html: `<h2>${escapeText(slide.title)}</h2>`, align: 'left', valign: 'top',
    })
  }
  const content = typeof slide.content === 'string' ? slide.content.trim() : ''
  if (content && content !== '<p></p>') {
    objs.push({
      id: newObjectId(), type: 'text',
      ...(slide.title ? DEFAULT_TEXT : { x: 0.08, y: 0.12, w: 0.84, h: 0.7 }),
      rotation: 0, z: z++, html: content, align: 'left', valign: 'top',
    })
  }
  if (objs.length === 0) {
    // Empty slide → seed a single empty text box so the canvas is usable.
    objs.push({
      id: newObjectId(), type: 'text', ...DEFAULT_TEXT, rotation: 0, z: 1,
      html: '<p></p>', align: 'left', valign: 'top',
    })
  }
  return sanitizeObjects(objs)
}

/** Minimal HTML-escape for migrating a plain title string into an <h2>. */
export function escapeText(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * flowContentFromObjects — derive a legacy `content` HTML string + `title` from
 * the objects[], so thumbnails, speaker-notes print, and the PDF path (which
 * still read slide.content) keep working after a slide is edited on the canvas.
 * Concatenates text objects top-to-bottom; images/shapes are skipped here (they
 * export via the positioned PPTX path).
 */
export function flowContentFromObjects(objects: unknown): string {
  const texts = sanitizeObjects(objects)
    .filter((o): o is TextSlideObject => o.type === 'text')
    .sort((a, b) => a.y - b.y || a.x - b.x)
  const html = texts.map((o) => o.html).join('')
  return html || '<p></p>'
}

// ── z-order helpers ──────────────────────────────────────────────────────────
/** Return objects sorted by z ascending (render order — last paints on top). */
export function sortByZ<T extends { id: string; z?: number }>(objects: readonly T[]): T[] {
  return [...objects].sort((a, b) => (a.z ?? 0) - (b.z ?? 0) || (a.id < b.id ? -1 : 1))
}

/** Re-pack z into a dense 1..N sequence preserving relative order. */
export function normalizeZ<T extends { id: string; z: number }>(objects: readonly T[]): T[] {
  const sorted = sortByZ(objects)
  const zById = new Map<string, number>()
  sorted.forEach((o, i) => zById.set(o.id, i + 1))
  return objects.map((o) => ({ ...o, z: zById.get(o.id) ?? o.z }))
}
