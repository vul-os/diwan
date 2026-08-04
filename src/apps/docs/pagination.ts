/**
 * pagination.js — P1: real, rendered page boundaries.
 * ============================================================================
 * The #1 credibility gap vs Google Docs / Word was that the editor showed a
 * single tall "paper" card with only a *word-count estimate* of pages — never a
 * rendered page 2, page 3, … This module measures the actual laid-out content
 * and computes where page breaks fall, so the editor can draw visible page
 * boundaries and a real page count.
 *
 * ── Approach: measured flow (not print-media, not doc-mutation) ──────────────
 * We measure the rendered height of each TOP-LEVEL block element inside the
 * ProseMirror doc (paragraphs, headings, tables, images, lists, the footnotes
 * list, …) via getBoundingClientRect, then greedily pack them into pages of
 * `contentHeightPx` (from the page-setup geometry). The output is a list of
 * break offsets (a y-position, in px, relative to the editor content top) plus a
 * page count. A view layer (PageBreaks overlay in DocsEditor) draws a gap +
 * "page N" chrome at each break.
 *
 * We ALSO honour explicit page breaks the author inserts (`page-break-after` /
 * a `[data-page-break]` element / a mathBlock/table too tall for a page): an
 * explicit break forces the next block onto a fresh page.
 *
 * ── Why this is CRDT / collab-safe ───────────────────────────────────────────
 * Pagination is a pure VIEW concern. We never insert page-break nodes into the
 * document, never mutate the ProseMirror doc, and never sync break positions
 * over the CRDT. Two peers with the same content but different window sizes can
 * compute different break positions locally with zero divergence — the document
 * bytes are identical. The measurement runs off a DEBOUNCED requestAnimationFrame
 * so it never reflows on every keystroke.
 */

/**
 * Measure page breaks for a rendered editor.
 *
 * @param {HTMLElement} contentEl  the `.tiptap` ProseMirror content element
 * @param {number} pageContentHeightPx  usable content height of one page (px)
 * @returns {{ breaks: number[], pageCount: number, contentHeight: number }}
 *   breaks — y-offsets (px, relative to contentEl top) where a page ends and the
 *            next begins, in ascending order. length === pageCount - 1.
 */
export interface PageBreaksResult {
  breaks: number[]
  pageCount: number
  contentHeight: number
}

export function measurePageBreaks(contentEl: HTMLElement | null | undefined, pageContentHeightPx: number): PageBreaksResult {
  if (!contentEl || !(pageContentHeightPx > 0)) {
    return { breaks: [], pageCount: 1, contentHeight: 0 }
  }
  const containerTop = contentEl.getBoundingClientRect().top
  const blocks = Array.from(contentEl.children)
  const totalHeight = contentEl.getBoundingClientRect().height

  if (blocks.length === 0) {
    return { breaks: [], pageCount: 1, contentHeight: totalHeight }
  }

  const breaks: number[] = []
  // `pageTop` is the y-offset (relative to content top) where the CURRENT page
  // begins. A block whose bottom crosses pageTop + pageHeight starts a new page.
  let pageTop = 0

  for (let i = 0; i < blocks.length; i++) {
    const el = blocks[i]
    const rect = el.getBoundingClientRect()
    const top = rect.top - containerTop
    const bottom = rect.bottom - containerTop
    const pageBottom = pageTop + pageContentHeightPx

    // A block taller than a whole page can't fit anywhere; let it overflow the
    // page it starts on (we don't split a single node — that would require doc
    // surgery). The next block still gets a fresh page.
    const blockHeight = bottom - top

    if (i > 0 && bottom > pageBottom + 1) {
      // This block spills past the current page's bottom → break before it.
      // Snap the break to where this block starts (its top), so the block moves
      // wholesale to the next page.
      const breakAt = top
      // Guard against a break at (or before) the current page top (can happen if
      // a single huge block is taller than a page) — advance at least one page.
      if (breakAt > pageTop + 1) {
        breaks.push(breakAt)
        pageTop = breakAt
      } else {
        // Oversized block: advance the page frame past it so following content
        // paginates correctly, but don't emit a zero-height page.
        pageTop = bottom
        if (breaks.length === 0 || breaks[breaks.length - 1] !== bottom) breaks.push(bottom)
      }
    }

    // Honour an explicit author page break AFTER this block.
    const forcesAfter = hasExplicitBreak(el)
    if (forcesAfter && i < blocks.length - 1) {
      pageTop = bottom
      breaks.push(bottom)
    }

    // If even after moving to a new page the block is taller than a page, keep
    // the frame aligned to its bottom so the next block starts cleanly.
    if (blockHeight > pageContentHeightPx) {
      pageTop = Math.max(pageTop, bottom - pageContentHeightPx)
    }
  }

  // De-dupe + sort (explicit + measured breaks can coincide) and drop any that
  // exceed the content height.
  const clean = Array.from(new Set(breaks.map((b) => Math.round(b))))
    .filter((b) => b > 0 && b < totalHeight - 1)
    .sort((a, b) => a - b)

  return { breaks: clean, pageCount: clean.length + 1, contentHeight: totalHeight }
}

/** True if a top-level block element carries an explicit page break. */
function hasExplicitBreak(el: Element | null | undefined): boolean {
  if (!el || el.nodeType !== 1) return false
  if (el.hasAttribute?.('data-page-break')) return true
  try {
    const style = el.getAttribute?.('style') || ''
    if (/page-break-after\s*:\s*always/i.test(style)) return true
    if (/break-after\s*:\s*page/i.test(style)) return true
  } catch { /* noop */ }
  return false
}

/**
 * Debounce helper used by the editor's pagination effect. Coalesces bursts of
 * updates (typing) into a single measurement on the next idle frame.
 */
export interface DebouncedMeasure {
  (): void
  cancel: () => void
  flush: () => void
}

export function createDebouncedMeasure(fn: () => void, delayMs = 250): DebouncedMeasure {
  let timer: ReturnType<typeof setTimeout> | null = null
  let raf: number | null = null
  const run = () => {
    if (raf) cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => { raf = null; fn() })
  }
  const debounced = (() => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(run, delayMs)
  }) as DebouncedMeasure
  debounced.cancel = () => {
    if (timer) clearTimeout(timer)
    if (raf) cancelAnimationFrame(raf)
    timer = null
    raf = null
  }
  debounced.flush = () => { if (timer) clearTimeout(timer); run() }
  return debounced
}
