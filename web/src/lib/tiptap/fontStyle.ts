/**
 * fontStyle.js — TipTap extensions that make the Docs/Slides toolbar's
 * font-size and font-family selectors actually render.
 *
 * The base `@tiptap/extension-text-style` mark is only a shell: it renders a
 * `<span>` but defines NO attributes of its own. The Color extension is what
 * teaches `textStyle` to carry a `color` attribute; `fontFamily`/`fontSize`
 * need the same treatment. Without these extensions, calling
 * `setMark('textStyle', { fontSize: '18pt' })` stores the attribute in the
 * ProseMirror state but drops it on render — so the text never changed size.
 *
 * We hand-roll these (rather than pull in `@tiptap/extension-font-family`) to
 * match the repo's existing pattern of small inline marks (Subscript /
 * Superscript in DocsEditor) and to avoid a new npm dependency.
 *
 * The attribute configs are exported separately so they can be unit-tested
 * without spinning up a real editor.
 */

import { Extension } from '@tiptap/react'

// A short allow-list of CSS length units we accept for a font size. Anything
// else is treated as a bare number and gets `pt` appended. This keeps a stray
// value from injecting arbitrary CSS via the style attribute.
const SIZE_UNIT_RE = /^\d+(\.\d+)?(pt|px|em|rem|%)$/

/**
 * normalizeFontSize — coerce a user/library value into a safe CSS length.
 * Returns null for empty/invalid input (which clears the attribute).
 */
export function normalizeFontSize(value: unknown): string | null {
  if (value == null) return null
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const v = String(value).trim()
  if (!v) return null
  if (SIZE_UNIT_RE.test(v)) return v
  const n = parseFloat(v)
  if (!Number.isFinite(n) || n <= 0 || n > 400) return null
  return `${n}pt`
}

/**
 * sanitizeFontFamily — strip characters that could break out of the style
 * attribute. Font stacks are quoted/comma-separated identifiers; a semicolon
 * or angle bracket has no business there.
 */
export function sanitizeFontFamily(value: unknown): string | null {
  if (value == null) return null
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const v = String(value).trim()
  if (!v) return null
  if (/[;<>{}]/.test(v)) return null
  return v
}

// Exported attribute config for `fontSize` on textStyle (unit-testable).
export const fontSizeAttribute = {
  default: null as string | null,
  parseHTML: (element: HTMLElement) => element.style.fontSize || null,
  renderHTML: (attributes: { fontSize?: unknown }) => {
    const size = normalizeFontSize(attributes.fontSize)
    if (!size) return {}
    return { style: `font-size: ${size}` }
  },
}

// Exported attribute config for `fontFamily` on textStyle (unit-testable).
export const fontFamilyAttribute = {
  default: null as string | null,
  parseHTML: (element: HTMLElement) => element.style.fontFamily?.replace(/['"]/g, '') || null,
  renderHTML: (attributes: { fontFamily?: unknown }) => {
    const family = sanitizeFontFamily(attributes.fontFamily)
    if (!family) return {}
    return { style: `font-family: ${family}` }
  },
}

export const FontSize = Extension.create({
  name: 'fontSize',
  addOptions() {
    return { types: ['textStyle'] }
  },
  addGlobalAttributes() {
    return [{ types: this.options.types, attributes: { fontSize: fontSizeAttribute } }]
  },
})

export const FontFamily = Extension.create({
  name: 'fontFamily',
  addOptions() {
    return { types: ['textStyle'] }
  },
  addGlobalAttributes() {
    return [{ types: this.options.types, attributes: { fontFamily: fontFamilyAttribute } }]
  },
})
