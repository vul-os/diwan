/**
 * pageSetup.js — P3: page size, orientation, and margins.
 * ============================================================================
 * A small, pure model for the document's page geometry. This drives:
 *   • P1 pagination — the rendered page height/width and the content column.
 *   • P2 headers/footers — the header/footer bands sit inside the margins.
 *   • Export — HTML `@page` rules + DOCX section page size/margins.
 *
 * ── Where does this live? (collab / CRDT safety) ─────────────────────────────
 * Page setup is DOCUMENT metadata, not layout state — like the title. It is
 * persisted per-file (in the file record, alongside title/content) and is small,
 * bounded, and enumerated (a size KEY, an orientation KEY, numeric margins). It
 * is NOT synced through the realtime text CRDT (which carries only body text);
 * it rides the same authoritative save/load as the doc JSON. Because every field
 * is validated on read (normalizePageSetup), a malicious peer/import can at worst
 * set a bounded margin / a known size key — never inject markup or a fetch.
 */

// Page sizes in CSS inches (width × height, portrait). 96px = 1in on screen.
export const PAGE_SIZES = {
  letter: { label: 'Letter (8.5 × 11 in)', width: 8.5, height: 11 },
  a4:     { label: 'A4 (210 × 297 mm)',    width: 8.27, height: 11.69 },
  legal:  { label: 'Legal (8.5 × 14 in)',  width: 8.5, height: 14 },
  tabloid:{ label: 'Tabloid (11 × 17 in)', width: 11, height: 17 },
}

export type PageSizeKey = keyof typeof PAGE_SIZES
export type PageOrientation = 'portrait' | 'landscape'

export interface Margins {
  top: number
  right: number
  bottom: number
  left: number
}

export interface PageSetup {
  size: PageSizeKey
  orientation: PageOrientation
  margins: Margins
}

export interface PageDimensions extends PageSetup {
  pageWidthPx: number
  pageHeightPx: number
  marginTopPx: number
  marginRightPx: number
  marginBottomPx: number
  marginLeftPx: number
  contentWidthPx: number
  contentHeightPx: number
}

export const DEFAULT_MARGIN_IN = 1 // 1-inch margins all round (Docs/Word default)
export const PX_PER_IN = 96
const MAX_MARGIN_IN = 4
const MIN_MARGIN_IN = 0

export const DEFAULT_PAGE_SETUP: PageSetup = Object.freeze({
  size: 'letter',
  orientation: 'portrait',   // 'portrait' | 'landscape'
  margins: { top: DEFAULT_MARGIN_IN, right: DEFAULT_MARGIN_IN, bottom: DEFAULT_MARGIN_IN, left: DEFAULT_MARGIN_IN },
})

function clampMargin(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return DEFAULT_MARGIN_IN
  return Math.min(MAX_MARGIN_IN, Math.max(MIN_MARGIN_IN, n))
}

function isPageSizeKey(v: unknown): v is PageSizeKey {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(PAGE_SIZES, v)
}

/**
 * Validate + normalise an arbitrary (possibly peer/imported) page-setup object
 * into a safe, complete config. Fail-closed: unknown size/orientation fall back
 * to the default; margins are clamped to a sane inch range.
 */
export function normalizePageSetup(input: unknown): PageSetup {
  const s = (input && typeof input === 'object' ? input : {}) as Partial<PageSetup>
  const size = isPageSizeKey(s.size) ? s.size : DEFAULT_PAGE_SETUP.size
  const orientation = s.orientation === 'landscape' ? 'landscape' : 'portrait'
  const m = (s.margins && typeof s.margins === 'object' ? s.margins : {}) as Partial<Margins>
  return {
    size,
    orientation,
    margins: {
      top: clampMargin(m.top ?? DEFAULT_MARGIN_IN),
      right: clampMargin(m.right ?? DEFAULT_MARGIN_IN),
      bottom: clampMargin(m.bottom ?? DEFAULT_MARGIN_IN),
      left: clampMargin(m.left ?? DEFAULT_MARGIN_IN),
    },
  }
}

/**
 * Resolve a page-setup config into concrete pixel geometry for rendering.
 * Returns page + content-box dimensions in CSS px (at 96dpi).
 */
export function pageDimensions(setup: unknown): PageDimensions {
  const cfg = normalizePageSetup(setup)
  const size = PAGE_SIZES[cfg.size]
  let wIn = size.width
  let hIn = size.height
  if (cfg.orientation === 'landscape') { const t = wIn; wIn = hIn; hIn = t }
  const pageWidthPx = Math.round(wIn * PX_PER_IN)
  const pageHeightPx = Math.round(hIn * PX_PER_IN)
  const m = cfg.margins
  return {
    ...cfg,
    pageWidthPx,
    pageHeightPx,
    marginTopPx: Math.round(m.top * PX_PER_IN),
    marginRightPx: Math.round(m.right * PX_PER_IN),
    marginBottomPx: Math.round(m.bottom * PX_PER_IN),
    marginLeftPx: Math.round(m.left * PX_PER_IN),
    // The writable content column width/height (page minus L/R and T/B margins).
    contentWidthPx: Math.round(pageWidthPx - (m.left + m.right) * PX_PER_IN),
    contentHeightPx: Math.round(pageHeightPx - (m.top + m.bottom) * PX_PER_IN),
  }
}

/** A CSS `@page` rule string for print/HTML export from a page-setup config. */
export function pageSetupToCssAtPage(setup: unknown): string {
  const cfg = normalizePageSetup(setup)
  const size = PAGE_SIZES[cfg.size]
  const dim = cfg.orientation === 'landscape'
    ? `${size.height}in ${size.width}in`
    : `${size.width}in ${size.height}in`
  const m = cfg.margins
  return `@page { size: ${dim}; margin: ${m.top}in ${m.right}in ${m.bottom}in ${m.left}in; }`
}
