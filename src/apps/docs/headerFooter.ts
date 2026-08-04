/**
 * headerFooter.js — P2: per-document headers & footers.
 * ============================================================================
 * A header and a footer band rendered on every page (ties into P1 pagination).
 * Each band holds editable text plus FIELDS that resolve at render time:
 *   {{page}}   → the current page number
 *   {{pages}}  → the total page count
 *   {{title}}  → the document title
 *   {{date}}   → today's date (locale-formatted)
 *
 * Options mirror Word/Docs: first-page-different and odd/even (mirrored) so a
 * report can suppress the header on the title page or alternate margins.
 *
 * ── Model & storage (collab safety) ──────────────────────────────────────────
 * Header/footer TEXT is document content — authored, user-supplied strings — so
 * it is SANITISED exactly like the body (sanitizeHeaderText below strips to
 * plain text: no markup, no fields-that-aren't-ours). The config is small,
 * bounded metadata persisted per-file alongside title/page-setup (NOT synced
 * over the realtime text CRDT). normalizeHeaderFooter validates every field on
 * read, so a hostile peer/import can at most set a bounded plain-text string.
 *
 * We keep the text as PLAIN strings (not rich HTML) deliberately: it removes the
 * entire markup-injection surface for this new region while still covering the
 * real use cases (title / page N of M / date / author). Field tokens are the
 * only "markup" and they are resolved by us into text, never into HTML.
 */

import { sanitizeToText } from '../../lib/sanitize'

const MAX_HF_LEN = 500

export interface HeaderFooterBand {
  left: string
  center: string
  right: string
}

export interface HeaderFooterConfig {
  enabled: boolean
  header: HeaderFooterBand
  footer: HeaderFooterBand
  differentFirstPage: boolean
  oddEven: boolean
}

export interface FieldContext {
  page?: number | string
  pages?: number | string
  title?: string
  date?: string
}

export const DEFAULT_HEADER_FOOTER: HeaderFooterConfig = Object.freeze({
  enabled: false,
  header: { left: '', center: '', right: '' },
  footer: { left: '', center: '', right: '' },
  differentFirstPage: false,
  oddEven: false,
})

function clampText(v: unknown): string {
  if (typeof v !== 'string') return ''
  // Strip ALL markup to plain text (defence-in-depth: this region is authored
  // content and must never carry HTML), then bound the length.
  return sanitizeToText(v).slice(0, MAX_HF_LEN)
}

/** Sanitise a single header/footer cell value to bounded plain text. */
export function sanitizeHeaderText(v: unknown): string {
  return clampText(v)
}

function normalizeBand(band: unknown): HeaderFooterBand {
  const b = (band && typeof band === 'object' ? band : {}) as Partial<HeaderFooterBand>
  return { left: clampText(b.left), center: clampText(b.center), right: clampText(b.right) }
}

/** Validate + normalise an arbitrary (peer/imported) header/footer config. */
export function normalizeHeaderFooter(input: unknown): HeaderFooterConfig {
  const s = (input && typeof input === 'object' ? input : {}) as Partial<HeaderFooterConfig>
  return {
    enabled: !!s.enabled,
    header: normalizeBand(s.header),
    footer: normalizeBand(s.footer),
    differentFirstPage: !!s.differentFirstPage,
    oddEven: !!s.oddEven,
  }
}

/** True if any band cell has content (used to decide whether to render bands). */
export function hasHeaderFooterContent(cfg: unknown): boolean {
  const c = normalizeHeaderFooter(cfg)
  const any = (band: HeaderFooterBand) => band.left || band.center || band.right
  return !!(c.enabled && (any(c.header) || any(c.footer)))
}

/**
 * Resolve field tokens in a header/footer cell string into concrete text.
 * @param {string} text        the raw cell text (already plain)
 * @param {object} ctx         { page, pages, title, date }
 * @returns {string}           text with {{…}} fields substituted
 */
export function resolveFields(text: unknown, ctx: FieldContext = {}): string {
  if (typeof text !== 'string' || !text) return ''
  const page = ctx.page != null ? String(ctx.page) : ''
  const pages = ctx.pages != null ? String(ctx.pages) : ''
  const title = ctx.title != null ? String(ctx.title) : ''
  const date = ctx.date != null
    ? String(ctx.date)
    : new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  return text
    .replace(/\{\{\s*page\s*\}\}/gi, page)
    .replace(/\{\{\s*pages\s*\}\}/gi, pages)
    .replace(/\{\{\s*title\s*\}\}/gi, title)
    .replace(/\{\{\s*date\s*\}\}/gi, date)
}

/**
 * Decide which header/footer band applies to a given (1-based) page number,
 * honouring first-page-different and odd/even. Returns the resolved
 * {left,center,right} for header and footer, or empty bands when suppressed.
 */
export function bandsForPage(cfg: unknown, pageNumber: number, ctx?: FieldContext) {
  const c = normalizeHeaderFooter(cfg)
  const empty: HeaderFooterBand = { left: '', center: '', right: '' }
  if (!c.enabled) return { header: empty, footer: empty }

  // First page different: page 1 uses no header/footer (Word's common default
  // is a distinct first-page band, but "suppress on page 1" is the frequent
  // case for title pages — we suppress, which is the safe, expected behaviour).
  if (c.differentFirstPage && pageNumber === 1) {
    return { header: empty, footer: empty }
  }

  // Inject the current page number into the field context so {{page}} resolves
  // even when the caller only supplies title/pages.
  const pageCtx: FieldContext = { ...ctx, page: pageNumber }
  const resolveBand = (band: HeaderFooterBand): HeaderFooterBand => ({
    left: resolveFields(band.left, pageCtx),
    center: resolveFields(band.center, pageCtx),
    right: resolveFields(band.right, pageCtx),
  })

  // Odd/even (mirrored): swap left/right on even pages so the outer edge stays
  // consistent in a bound document.
  const mirror = (band: HeaderFooterBand): HeaderFooterBand => (c.oddEven && pageNumber % 2 === 0
    ? { left: band.right, center: band.center, right: band.left }
    : band)

  return {
    header: mirror(resolveBand(c.header)),
    footer: mirror(resolveBand(c.footer)),
  }
}
