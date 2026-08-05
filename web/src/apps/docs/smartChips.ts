/**
 * smartChips.js — Docs SMART CHIPS (the @-menu differentiator).
 * ============================================================================
 * A "smart chip" is an inline, atomic pill inserted from an @-menu:
 *
 *   @person  → a people chip (someone on the document / a collaborator)
 *   @date    → a date chip (Today / Tomorrow / a parsed calendar date)
 *   @file    → a link chip to another Office document
 *   @place   → a free-text place / label chip
 *
 * This is the single biggest editor differentiator versus both Google Docs and
 * Word's @-mentions, and it is built here on TipTap/ProseMirror PRIMITIVES —
 * a self-contained inline atom `Node` plus a pure trigger-detection helper — so
 * it needs no `@tiptap/extension-mention` / `@tiptap/suggestion` dependency and
 * matches the codebase's existing custom-node idiom (equation.js, footnotes.js).
 *
 * ── SECURITY (the whole point of the containment design) ─────────────────────
 * A chip's document content is ONLY plain-text attributes: `chipType`, `label`,
 * `refId`, `refHref`. Nothing user- or peer-supplied is ever rendered as markup:
 *
 *   • renderHTML() emits the label as a ProseMirror text-node child (a DOM
 *     text node — escaped by construction), never as innerHTML.
 *   • The NodeView paints the label with `textContent` (never innerHTML), so a
 *     label like `<img src=x onerror=…>` renders as inert literal text.
 *   • On HTML export the chip's `<span data-smart-chip>…label…</span>` passes
 *     through sanitizeDocHtml (the export trust boundary) like any other markup.
 *   • On DOCX export the label is written as a docx TextRun (docx escapes it).
 *   • `refHref` (the file-chip navigation target) is an INTERNAL path validated
 *     against a strict allow-list before it is ever used to navigate — a chip
 *     carrying `refHref="javascript:…"` / an external URL can never navigate.
 *
 * So a malicious peer/import can at worst PUT a hostile *string* into a chip
 * attribute, which renders inertly and cannot navigate anywhere off-app.
 */

import { Node, mergeAttributes, type NodeViewRendererProps } from '@tiptap/react'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { EditorState } from '@tiptap/pm/state'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    smartChip: {
      insertSmartChip: (attrs?: {
        chipType?: unknown
        label?: unknown
        refId?: unknown
        refHref?: unknown
      }) => ReturnType
    }
  }
}

// A chip label is display text; cap it so a hostile import can't stuff a
// megabyte string into an inline node. 200 chars is far beyond any real label.
export const MAX_CHIP_LABEL = 200

export const CHIP_TYPES = Object.freeze(['person', 'date', 'file', 'place'] as const)
export type ChipType = (typeof CHIP_TYPES)[number]

// File-chip navigation targets are INTERNAL app routes only. A chip may never
// navigate to an external URL or a javascript:/data: scheme — validate against
// this allow-list before ever using refHref to route. Fail-closed.
const SAFE_CHIP_HREF = /^(?:docs|sheets|slides|pdf)\/[A-Za-z0-9_-]+$/

/** True when a file-chip's refHref is a safe internal app route. */
export function isSafeChipHref(href: unknown): href is string {
  return typeof href === 'string' && SAFE_CHIP_HREF.test(href)
}

/** Map a stored file `type` to its in-app route prefix (for a file chip). */
export function routeForFileType(type: unknown): string | null {
  switch (type) {
    case 'doc':
    case 'docs':
    case 'document':
      return 'docs'
    case 'sheet':
    case 'sheets':
    case 'spreadsheet':
      return 'sheets'
    case 'slide':
    case 'slides':
    case 'presentation':
      return 'slides'
    case 'pdf':
      return 'pdf'
    default:
      return null
  }
}

// The glyph shown before each chip label in the live NodeView. Cosmetic only —
// it is NOT part of the stored label, never exported, and carries no data.
const CHIP_GLYPH: Record<ChipType, string> = { person: '@', date: '📅', file: '📄', place: '📍' }

function clampLabel(v: unknown): string {
  const s = typeof v === 'string' ? v : ''
  return s.length > MAX_CHIP_LABEL ? s.slice(0, MAX_CHIP_LABEL) : s
}

function normType(v: unknown): ChipType {
  return typeof v === 'string' && (CHIP_TYPES as readonly string[]).includes(v) ? (v as ChipType) : 'place'
}

/**
 * SmartChip — an inline, atomic TipTap node. Selectable but not editable; its
 * data lives entirely in plain-text attributes (collab/CRDT-safe like an image).
 */
export const SmartChip = Node.create({
  name: 'smartChip',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      chipType: {
        default: 'place',
        parseHTML: (el: HTMLElement) => normType(el.getAttribute('data-chip-type')),
        renderHTML: (attrs: { chipType?: unknown }) => ({ 'data-chip-type': normType(attrs.chipType) }),
      },
      label: {
        default: '',
        // On import, prefer an explicit data attr, else the element's text.
        parseHTML: (el: HTMLElement) => clampLabel(el.getAttribute('data-chip-label') || el.textContent || ''),
        // The label is NOT emitted as an attribute — it is serialized ONLY as the
        // escaped text-node child in renderHTML(). Emitting it as an attribute too
        // would carry the raw (un-escaped-looking) string in the markup for no
        // benefit; the text child round-trips it and is escaped by construction.
        renderHTML: () => ({}),
      },
      refId: {
        default: '',
        parseHTML: (el: HTMLElement) => (el.getAttribute('data-chip-ref') || '').slice(0, 256),
        renderHTML: (attrs: { refId?: unknown }) =>
          (typeof attrs.refId === 'string' && attrs.refId ? { 'data-chip-ref': attrs.refId.slice(0, 256) } : {}),
      },
      refHref: {
        default: '',
        // Only keep an internal, allow-listed route; drop anything else so a
        // hostile import can't smuggle a navigation target through parse.
        parseHTML: (el: HTMLElement) => {
          const h = el.getAttribute('data-chip-href') || ''
          return isSafeChipHref(h) ? h : ''
        },
        renderHTML: (attrs: { refHref?: unknown }) =>
          (isSafeChipHref(attrs.refHref) ? { 'data-chip-href': attrs.refHref } : {}),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-smart-chip]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    const type = normType(node.attrs.chipType)
    const label = clampLabel(node.attrs.label)
    // The label is emitted as a TEXT-NODE child (the trailing string in the
    // spec) — ProseMirror's DOMSerializer creates it via createTextNode, so it
    // is escaped by construction and can never become live markup.
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-smart-chip': '',
        class: `smart-chip smart-chip-${type}`,
        // A chip is inert text on paper; make it non-editable in the DOM too.
        contenteditable: 'false',
      }),
      label,
    ]
  },

  addNodeView() {
    return ({ node }: NodeViewRendererProps) => {
      const dom = document.createElement('span')
      const paint = (n: PMNode) => {
        const type = normType(n.attrs.chipType)
        const label = clampLabel(n.attrs.label)
        dom.className = `smart-chip smart-chip-${type}`
        dom.setAttribute('data-smart-chip', '')
        dom.setAttribute('data-chip-type', type)
        dom.setAttribute('contenteditable', 'false')
        if (n.attrs.refId) dom.setAttribute('data-chip-ref', String(n.attrs.refId).slice(0, 256))
        if (isSafeChipHref(n.attrs.refHref)) {
          dom.setAttribute('data-chip-href', n.attrs.refHref)
          dom.setAttribute('role', 'link')
          dom.setAttribute('tabindex', '0')
        }
        dom.title = label
        // textContent (never innerHTML): a hostile label renders as literal text.
        dom.textContent = `${CHIP_GLYPH[type] || ''} ${label}`.trim()
      }
      paint(node)
      return {
        dom,
        update(updated: PMNode) {
          if (updated.type.name !== node.type.name) return false
          paint(updated)
          return true
        },
        ignoreMutation: () => true,
      }
    }
  },

  addCommands() {
    return {
      insertSmartChip:
        (attrs: { chipType?: unknown; label?: unknown; refId?: unknown; refHref?: unknown } = {}) =>
        ({ chain }) => {
          const clean = {
            chipType: normType(attrs.chipType),
            label: clampLabel(attrs.label),
            refId: typeof attrs.refId === 'string' && attrs.refId ? attrs.refId.slice(0, 256) : '',
            refHref: isSafeChipHref(attrs.refHref) ? attrs.refHref : '',
          }
          // Insert the chip followed by a space so the caret lands after it and
          // the user can keep typing.
          return chain()
            .insertContent([
              { type: 'smartChip', attrs: clean },
              { type: 'text', text: ' ' },
            ])
            .run()
        },
    }
  },
})

// ---------------------------------------------------------------------------
// Trigger detection (pure — unit-tested without a browser).
// ---------------------------------------------------------------------------

// `@` starts a chip only at a word boundary (start of block or after
// whitespace / an opening bracket) so an EMAIL (`a@b`) never opens the menu.
// The query is the run of chip-name characters after the `@`.
const CHIP_TRIGGER = /(?:^|[\s([{<])@([\p{L}\p{N}._-]*)$/u

export interface ChipTriggerMatch {
  from: number
  to: number
  query: string
}

/**
 * Detect an active @-chip trigger immediately before the (collapsed) caret.
 * Returns `{ from, to, query }` in absolute document positions, or null.
 *
 * `from`/`to` bound the literal `@query` text so the caller can delete exactly
 * that when a chip is chosen. Because `@` + query are all plain-text characters
 * directly before the caret (each of ProseMirror size 1), `from = to - (len+1)`
 * — no fragile block-offset mapping over inline atoms is needed.
 */
export function detectChipTrigger(state: EditorState): ChipTriggerMatch | null {
  const sel = state?.selection
  if (!sel || !sel.empty) return null
  const $from = sel.$from
  if (!$from.parent || !$from.parent.isTextblock) return null
  // Text of the current block up to the caret. textBetween replaces inline leaf
  // nodes (images/other chips) with the object-replacement char so a `@` right
  // after one still triggers, and the regex's boundary class excludes it.
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, '￼', '￼')
  const m = CHIP_TRIGGER.exec(textBefore)
  if (!m) return null
  const query = m[1]
  const to = sel.from
  const from = to - (query.length + 1) // '@' + query, all size-1 text chars
  if (from < 0) return null
  return { from, to, query }
}

// ---------------------------------------------------------------------------
// Suggestion building (pure — unit-tested).
// ---------------------------------------------------------------------------

function includesCI(hay: unknown, needle: unknown): boolean {
  if (!needle) return true
  const h = typeof hay === 'string' || typeof hay === 'number' ? String(hay) : ''
  const n = typeof needle === 'string' || typeof needle === 'number' ? String(needle) : ''
  return h.toLowerCase().includes(n.toLowerCase())
}

function fmtDate(d: Date): string {
  // Locale-independent, stable label: e.g. "Jul 14, 2026".
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
}

function isoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export interface ChipPersonSource {
  id: string
  name?: string
}

export interface ChipFileSource {
  id: string
  name?: string
  type?: string
}

export interface ChipSuggestionSources {
  people: ChipPersonSource[]
  files: ChipFileSource[]
  /** injectable clock (tests) */
  now?: Date
}

export interface ChipSuggestion {
  key: string
  chipType: ChipType
  label: string
  refId: string
  refHref: string
  hint: string
}

/**
 * Build the ranked suggestion list for an @-menu query.
 */
export function buildChipSuggestions(
  query: string,
  sources: ChipSuggestionSources = { people: [], files: [] },
): ChipSuggestion[] {
  const q = (query || '').trim()
  const people = Array.isArray(sources.people) ? sources.people : []
  const files = Array.isArray(sources.files) ? sources.files : []
  const now = sources.now instanceof Date ? sources.now : new Date()
  const out: ChipSuggestion[] = []

  // People (from the document's collaborators — NOT the whole directory, so an
  // @-menu can never enumerate accounts the user can't already see on this doc).
  for (const p of people) {
    if (!p || !p.id) continue
    const name = p.name || p.id
    if (!includesCI(name, q) && !includesCI(p.id, q)) continue
    out.push({
      key: `person:${p.id}`,
      chipType: 'person',
      label: name,
      refId: p.id,
      refHref: '',
      hint: 'Person',
    })
    if (out.length >= 40) break
  }

  // Files (the user's own documents — link chips).
  for (const f of files) {
    if (!f || !f.id) continue
    const name = f.name || 'Untitled'
    if (!includesCI(name, q)) continue
    const route = routeForFileType(f.type)
    out.push({
      key: `file:${f.id}`,
      chipType: 'file',
      label: name,
      refId: f.id,
      refHref: route ? `${route}/${f.id}` : '',
      hint: 'File',
    })
    if (out.length >= 60) break
  }

  // Dates. Always offer Today + Tomorrow (filtered by query); parse an explicit
  // date if the query looks like one.
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const tomorrow = new Date(today.getTime() + 86400000)
  const dateOpts = [
    { label: `Today (${fmtDate(today)})`, d: today, kw: 'today' },
    { label: `Tomorrow (${fmtDate(tomorrow)})`, d: tomorrow, kw: 'tomorrow' },
  ]
  for (const o of dateOpts) {
    if (q && !includesCI(o.kw, q) && !includesCI(o.label, q)) continue
    out.push({
      key: `date:${o.kw}`,
      chipType: 'date',
      label: fmtDate(o.d),
      refId: isoDate(o.d),
      refHref: '',
      hint: 'Date',
    })
  }
  // Explicit parse (e.g. "@2026-08-01" or "@Aug 1 2026"). Guard against Date's
  // permissive parsing pulling a date out of an unrelated query.
  if (q && /\d/.test(q)) {
    const parsed = new Date(q)
    if (!Number.isNaN(parsed.getTime())) {
      const d = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate())
      out.push({
        key: `date:${isoDate(d)}`,
        chipType: 'date',
        label: fmtDate(d),
        refId: isoDate(d),
        refHref: '',
        hint: 'Date',
      })
    }
  }

  // Place — a free-text label chip from whatever the user typed.
  if (q) {
    out.push({
      key: `place:${q}`,
      chipType: 'place',
      label: q,
      refId: '',
      refHref: '',
      hint: 'Place / label',
    })
  }

  return out
}
